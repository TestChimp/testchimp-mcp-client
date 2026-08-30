/**
 * Localhost LLM retry proxy for ChimpHands: forwards OpenCode /v1 calls to FeatureService
 * and retries transient 502/503/504 + network failures (30s delay, up to 5 min).
 */
import http from "node:http";
import { URL } from "node:url";

const DEFAULT_DELAY_MS = 30_000;
const DEFAULT_MAX_MS = 300_000;

export type LlmRetryConfig = {
  delayMs: number;
  maxMs: number;
};

export type LlmRetryDeps = {
  delayMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveLlmRetryConfig(): LlmRetryConfig {
  const delayRaw = Number(process.env.CHIMPHANDS_LLM_RETRY_DELAY_MS ?? DEFAULT_DELAY_MS);
  const maxRaw = Number(process.env.CHIMPHANDS_LLM_RETRY_MAX_MS ?? DEFAULT_MAX_MS);
  return {
    delayMs: Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : DEFAULT_DELAY_MS,
    maxMs: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX_MS,
  };
}

export function isChimphandsLlmRetryEnabled(): boolean {
  const v = (process.env.CHIMPHANDS_LLM_RETRY ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export function isRetryableLlmFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function isRetryableLlmNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN/i.test(
      String(err),
    );
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  return /fetch failed|socket hang up|network|timed out|timeout/i.test(err.message);
}

function formatRemainingMs(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

/** Retry upstream fetch until success, non-retryable status, or deadline. */
export async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  deps: LlmRetryDeps = {},
): Promise<Response> {
  const cfg = resolveLlmRetryConfig();
  const delayMs = deps.delayMs ?? cfg.delayMs;
  const maxMs = deps.maxMs ?? cfg.maxMs;
  const sleepFn = deps.sleep ?? defaultSleep;
  const nowFn = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? ((msg: string) => console.error(msg));

  let attempt = 0;
  let deadline: number | undefined;

  while (true) {
    attempt += 1;
    try {
      const res = await fetchFn(url, init);
      if (!isRetryableLlmFailure(res.status)) {
        return res;
      }
      if (deadline === undefined) {
        deadline = nowFn() + maxMs;
      }
      const remaining = deadline - nowFn();
      if (remaining <= 0) {
        return res;
      }
      const waitMs = Math.min(delayMs, remaining);
      log(
        `ChimpHands LLM proxy: upstream ${res.status}, retry in ${Math.round(waitMs / 1000)}s (attempt ${attempt}, ~${formatRemainingMs(remaining)} remaining)`,
      );
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore body drain errors */
      }
      await sleepFn(waitMs);
      continue;
    } catch (err) {
      if (!isRetryableLlmNetworkError(err)) {
        throw err;
      }
      if (deadline === undefined) {
        deadline = nowFn() + maxMs;
      }
      const remaining = deadline - nowFn();
      if (remaining <= 0) {
        throw err;
      }
      const waitMs = Math.min(delayMs, remaining);
      const detail = err instanceof Error ? err.message : String(err);
      log(
        `ChimpHands LLM proxy: upstream network error (${detail}), retry in ${Math.round(waitMs / 1000)}s (attempt ${attempt}, ~${formatRemainingMs(remaining)} remaining)`,
      );
      await sleepFn(waitMs);
    }
  }
}

function stripHopByHopHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export type LlmRetryProxyHandle = {
  baseUrl: string;
  stop: () => Promise<void>;
};

/** Start a localhost proxy that forwards to FeatureService /v1 with retry. */
export async function startLlmRetryProxy(
  upstreamLlmBase: string,
  deps: LlmRetryDeps = {},
): Promise<LlmRetryProxyHandle> {
  const upstream = new URL(upstreamLlmBase.replace(/\/$/, "") + "/");
  const upstreamOrigin = upstream.origin;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const pathWithQuery = req.url || "/";
        const targetUrl = new URL(pathWithQuery, upstreamOrigin).toString();
        const method = req.method || "GET";
        const body = await readRequestBody(req);
        const headers = stripHopByHopHeaders(req.headers);
        const init: RequestInit = {
          method,
          headers,
          body:
            body && method !== "GET" && method !== "HEAD" ? new Uint8Array(body) : undefined,
        };

        const upstreamRes = await fetchUpstreamWithRetry(targetUrl, init, deps);
        const responseHeaders: Record<string, string> = {};
        upstreamRes.headers.forEach((value, key) => {
          if (key.toLowerCase() === "transfer-encoding") return;
          responseHeaders[key] = value;
        });
        res.writeHead(upstreamRes.status, responseHeaders);

        if (upstreamRes.body) {
          const reader = upstreamRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.length) {
              res.write(Buffer.from(value));
            }
          }
        }
        res.end();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(msg);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("ChimpHands LLM retry proxy failed to bind");
  }

  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
