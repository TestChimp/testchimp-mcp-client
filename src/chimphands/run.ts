/**
 * ChimpHands GitHub Actions bridge: bootstrap → OpenCode → inbound SSE turns.
 * Relies on TESTCHIMP_API_KEY (+ optional TESTCHIMP_BACKEND_URL; defaults to prod).
 * Does not write mcp.json — CLI/skill use process env.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { getBackendUrl, requireApiKey } from "../core/client.js";

const ROLE_ASSISTANT = "CHIMPHANDS_MESSAGE_ROLE_ASSISTANT";
const ROLE_TOOL = "CHIMPHANDS_MESSAGE_ROLE_TOOL";
const ROLE_STATUS = "CHIMPHANDS_MESSAGE_ROLE_STATUS";

const STATUS_RUNNING = "CHIMPHANDS_SESSION_STATUS_RUNNING";
const STATUS_WAITING_USER = "CHIMPHANDS_SESSION_STATUS_WAITING_USER";
const STATUS_IDLE = "CHIMPHANDS_SESSION_STATUS_IDLE";
const STATUS_FAILED = "CHIMPHANDS_SESSION_STATUS_FAILED";

type BootstrapResponse = {
  session_id?: string;
  llm_base_url?: string;
  llm_api_key?: string;
  llm_model?: string;
  initial_prompt?: string;
  conversation_summary?: string;
  idle_timeout_seconds?: number;
  chimphands_service_account_user_id?: string;
  pending_user_messages?: Array<{ content?: string }>;
};

type RunOptions = {
  sessionId: string;
  prompt?: string;
};

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "TestChimp-Api-Key": apiKey,
  };
}

async function postJson(backend: string, apiKey: string, path: string, body: unknown): Promise<string> {
  const res = await fetch(`${backend}${path}`, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ChimpHands API ${res.status} ${path}: ${text}`);
  }
  return text;
}

function postJsonFireAndForget(backend: string, apiKey: string, path: string, body: unknown): void {
  void postJson(backend, apiKey, path, body).catch(() => {
    /* best-effort agent telemetry */
  });
}

function writeOpencodeConfig(backend: string, apiKey: string, boot: BootstrapResponse): void {
  const llmBase = (boot.llm_base_url || `${backend}/v1`).replace(/\/$/, "");
  const llmKey = apiKey || boot.llm_api_key || "";
  const llmModel = boot.llm_model || "gpt-4o-mini";
  writeFileSync(
    "opencode.json",
    JSON.stringify(
      {
        model: llmModel,
        provider: {
          openai: {
            apiKey: llmKey,
            baseURL: llmBase,
          },
        },
      },
      null,
      2,
    ),
  );
}

function runOpencode(
  prompt: string,
  childEnv: NodeJS.ProcessEnv,
  postEvent: (role: string, content: string, status?: string) => void,
): Promise<{ code: number; err: string }> {
  const help = (() => {
    try {
      return execFileSync("opencode", ["run", "--help"], { encoding: "utf8", env: childEnv });
    } catch {
      return "";
    }
  })();
  const useJson = help.includes("--format");
  if (useJson) {
    const child = spawn("opencode", ["run", prompt, "--format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    return new Promise((resolve) => {
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let content = line;
          let role = ROLE_ASSISTANT;
          try {
            const ev = JSON.parse(line) as {
              content?: string;
              message?: string;
              text?: string;
              type?: string;
              role?: string;
            };
            content = ev.content || ev.message || ev.text || JSON.stringify(ev);
            if (ev.type === "tool" || ev.role === "tool") role = ROLE_TOOL;
            if (ev.type === "status") role = ROLE_STATUS;
          } catch {
            /* plain line */
          }
          postEvent(role, content);
        }
      });
      child.on("close", (code) => {
        if (buf.trim()) postEvent(ROLE_ASSISTANT, buf.trim());
        resolve({ code: code == null ? 1 : code, err });
      });
    });
  }
  try {
    const out = execFileSync("opencode", ["run", prompt], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    if (out) postEvent(ROLE_ASSISTANT, out);
    return Promise.resolve({ code: 0, err: "" });
  } catch (e: unknown) {
    const errObj = e as { stderr?: Buffer; message?: string; status?: number };
    const err = (errObj.stderr && errObj.stderr.toString()) || errObj.message || "opencode failed";
    return Promise.resolve({ code: errObj.status || 1, err });
  }
}

function connectInbound(
  backend: string,
  apiKey: string,
  sessionId: string,
  onUserMessage: (content: string) => void,
  onIdle: () => void,
  onClosed: () => void,
): void {
  const url = new URL(`${backend}/api/chimphands/sessions/${encodeURIComponent(sessionId)}/inbound`);
  const lib = url.protocol === "https:" ? https : http;
  const req = lib.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "TestChimp-Api-Key": apiKey,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    },
    (res) => {
      let buf = "";
      let eventName = "message";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const line of parts) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim() || "message";
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (eventName === "idle") {
              onIdle();
            } else if (eventName === "user_message" || eventName === "message") {
              try {
                const msg = JSON.parse(data) as { content?: string };
                const content = msg.content || "";
                if (content) onUserMessage(content);
              } catch {
                /* ignore */
              }
            }
            eventName = "message";
          } else if (line === "") {
            eventName = "message";
          }
        }
      });
      res.on("end", () => onClosed());
    },
  );
  req.on("error", () => onClosed());
  req.end();
}

export async function runChimphands(opts: RunOptions): Promise<void> {
  const apiKey = requireApiKey();
  const backend = getBackendUrl();
  // Ensure child processes see the resolved backend (prod default when unset).
  process.env.TESTCHIMP_BACKEND_URL = backend;

  const sessionId = (opts.sessionId || process.env.SESSION_ID || "").trim();
  if (!sessionId) {
    throw new Error("session_id is required (pass --session-id or SESSION_ID)");
  }
  const promptInput = (opts.prompt ?? process.env.PROMPT ?? "").trim();

  const bootText = await postJson(backend, apiKey, "/api/chimphands/bootstrap", {
    session_id: sessionId,
  });
  const boot = JSON.parse(bootText) as BootstrapResponse;

  const userId = boot.chimphands_service_account_user_id || "";
  if (userId) {
    process.env.TESTCHIMP_USER_ID = userId;
  }

  mkdirSync(".opencode", { recursive: true });
  writeOpencodeConfig(backend, apiKey, boot);

  const idleMs = (Number(boot.idle_timeout_seconds) || 600) * 1000;
  const queue: string[] = [];
  let idle = false;
  let closed = false;
  let lastUserActivity = Date.now();

  const postEvent = (role: string, content: string, status?: string) => {
    const body: Record<string, unknown> = {
      session_id: sessionId,
      role,
      content: String(content || "").slice(0, 20000),
    };
    if (status != null) body.status = status;
    postJsonFireAndForget(backend, apiKey, "/api/chimphands/post_agent_event", body);
  };

  const complete = (status: string, errorMessage?: string) => {
    const body: Record<string, unknown> = { session_id: sessionId, status };
    if (errorMessage) body.error_message = String(errorMessage).slice(0, 4000);
    postJsonFireAndForget(backend, apiKey, "/api/chimphands/complete_session", body);
  };

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
  };
  if (userId) childEnv.TESTCHIMP_USER_ID = userId;

  connectInbound(
    backend,
    apiKey,
    sessionId,
    (content) => {
      queue.push(content);
      lastUserActivity = Date.now();
    },
    () => {
      idle = true;
    },
    () => {
      closed = true;
    },
  );

  postEvent(ROLE_STATUS, "Agent ready", STATUS_RUNNING);

  let prompt = promptInput || boot.initial_prompt || "";
  if (boot.conversation_summary) {
    prompt = `Conversation so far:\n${boot.conversation_summary}\n\nCurrent task:\n${prompt}`;
  }
  for (const m of boot.pending_user_messages || []) {
    if (m?.content) queue.push(m.content);
  }

  const waitForNextPrompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      const tick = () => {
        if (queue.length) {
          resolve(queue.shift()!);
          return;
        }
        if (idle || closed || Date.now() - lastUserActivity >= idleMs) {
          resolve(null);
          return;
        }
        setTimeout(tick, 500);
      };
      tick();
    });

  while (prompt) {
    const result = await runOpencode(prompt, childEnv, postEvent);
    if (result.code !== 0) {
      complete(STATUS_FAILED, result.err || "opencode failed");
      process.exitCode = result.code || 1;
      return;
    }
    postEvent(ROLE_STATUS, "Waiting for user input", STATUS_WAITING_USER);
    prompt = (await waitForNextPrompt()) || "";
  }

  complete(STATUS_IDLE);
}
