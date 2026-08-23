/**
 * ChimpHands GitHub Actions bridge: bootstrap → OpenCode → inbound SSE turns.
 * Relies on TESTCHIMP_API_KEY (+ optional TESTCHIMP_BACKEND_URL; defaults to prod).
 * Does not write mcp.json — TestChimp MCP is wired via opencode.json for OpenCode.
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

function ensureTestchimpPrompt(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;
  const rest = trimmed.replace(/^\/testchimp\s*/i, "").trim();
  return rest ? `/testchimp ${rest}` : "/testchimp";
}

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
  void postJson(backend, apiKey, path, body).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ChimpHands API telemetry failed ${path}: ${detail}`);
  });
}

const TESTCHIMP_PROVIDER_ID = "testchimp";

function resolveOpencodeModelId(boot: BootstrapResponse): string {
  const raw = (boot.llm_model || "gpt-4o-mini").trim();
  const modelId = raw.includes("/") ? raw.split("/").pop() || "gpt-4o-mini" : raw;
  return modelId;
}

function resolveOpencodeModel(boot: BootstrapResponse): string {
  return `${TESTCHIMP_PROVIDER_ID}/${resolveOpencodeModelId(boot)}`;
}

function extractOpencodeFatalError(raw: string): string | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    const ev = JSON.parse(line) as {
      type?: string;
      name?: string;
      message?: string;
      data?: { message?: string; ref?: string };
    };
    if (ev.type === "error" || ev.name === "UnknownError") {
      const msg = ev.data?.message || ev.message || line;
      const ref = ev.data?.ref ? ` (ref ${ev.data.ref})` : "";
      return `${msg}${ref}`;
    }
  } catch {
    /* plain text */
  }
  if (line.includes("Unexpected server error") && line.includes("UnknownError")) {
    return line;
  }
  const errorLine = line.match(/^Error:\s*(.+)$/i);
  if (errorLine?.[1]?.trim()) {
    return errorLine[1].trim();
  }
  if (/not found/i.test(line) && line.length < 240) {
    return line.trim();
  }
  return null;
}

function summarizeOpencodeFailure(stderr: string, stdout: string, exitCode: number | null): string {
  for (const chunk of [stderr, stdout]) {
    for (const line of chunk.split("\n")) {
      const fatal = extractOpencodeFatalError(line);
      if (fatal) return fatal;
    }
  }
  const merged = `${stderr}\n${stdout}`.trim();
  if (merged) {
    const errorLines = merged
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^error:/i.test(l) || /not found/i.test(l));
    if (errorLines.length) return errorLines[errorLines.length - 1].replace(/^error:\s*/i, "").trim();
    return merged.slice(0, 1200);
  }
  return exitCode ? `opencode exited with code ${exitCode}` : "opencode failed";
}

function writeOpencodeConfig(backend: string, apiKey: string, boot: BootstrapResponse): string {
  const llmBase = (boot.llm_base_url || `${backend}/v1`).replace(/\/$/, "");
  const llmKey = apiKey || boot.llm_api_key || "";
  const modelId = resolveOpencodeModelId(boot);
  const model = `${TESTCHIMP_PROVIDER_ID}/${modelId}`;
  const mcpEnv: Record<string, string> = {
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
  };
  const serviceUserId = boot.chimphands_service_account_user_id?.trim();
  if (serviceUserId) {
    mcpEnv.TESTCHIMP_USER_ID = serviceUserId;
  }
  writeFileSync(
    "opencode.json",
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model,
        autoupdate: false,
        provider: {
          [TESTCHIMP_PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "TestChimp",
            options: {
              apiKey: llmKey,
              baseURL: llmBase,
            },
            models: {
              [modelId]: {
                name: modelId,
              },
            },
          },
        },
        mcp: {
          testchimp: {
            type: "local",
            enabled: true,
            command: ["npx", "-y", "@testchimp/cli@latest", "mcp"],
            environment: mcpEnv,
          },
        },
      },
      null,
      2,
    ),
  );
  return model;
}

function runOpencode(
  prompt: string,
  model: string,
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
  const baseArgs = ["run", prompt, "--model", model];
  if (useJson) {
    const child = spawn("opencode", [...baseArgs, "--format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    return new Promise((resolve) => {
      let buf = "";
      let fatalError: string | null = null;
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const fatal = extractOpencodeFatalError(line);
          if (fatal) {
            fatalError = fatal;
            continue;
          }
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
        if (buf.trim()) {
          const fatal = extractOpencodeFatalError(buf);
          if (fatal) fatalError = fatal;
          else if (!fatalError) postEvent(ROLE_ASSISTANT, buf.trim());
        }
        const stderrFatal = extractOpencodeFatalError(err);
        if (stderrFatal) fatalError = stderrFatal;
        if (fatalError) {
          resolve({ code: 1, err: fatalError });
          return;
        }
        if (code != null && code !== 0) {
          resolve({ code, err: summarizeOpencodeFailure(err, buf, code) });
          return;
        }
        resolve({ code: code == null ? 1 : code, err });
      });
    });
  }
  try {
    const out = execFileSync("opencode", baseArgs, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    const fatal = extractOpencodeFatalError(out);
    if (fatal) return Promise.resolve({ code: 1, err: fatal });
    if (out) postEvent(ROLE_ASSISTANT, out);
    return Promise.resolve({ code: 0, err: "" });
  } catch (e: unknown) {
    const errObj = e as { stderr?: Buffer; stdout?: Buffer; message?: string; status?: number };
    const stderr = errObj.stderr?.toString() || "";
    const stdout = errObj.stdout?.toString() || "";
    const fatal = summarizeOpencodeFailure(stderr, stdout, errObj.status ?? 1);
    return Promise.resolve({ code: errObj.status || 1, err: fatal });
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
    sessionId,
  });
  const boot = JSON.parse(bootText) as BootstrapResponse;

  const githubRunId = (process.env.GITHUB_RUN_ID || "").trim();
  if (githubRunId) {
    postJsonFireAndForget(backend, apiKey, "/api/chimphands/post_agent_event", {
      sessionId,
      githubRunId,
    });
  }

  const userId = boot.chimphands_service_account_user_id || "";
  if (userId) {
    process.env.TESTCHIMP_USER_ID = userId;
  }

  mkdirSync(".opencode", { recursive: true });
  const opencodeModel = writeOpencodeConfig(backend, apiKey, boot);
  console.error(`ChimpHands OpenCode model: ${opencodeModel}`);

  const idleMs = (Number(boot.idle_timeout_seconds) || 600) * 1000;
  const queue: string[] = [];
  let idle = false;
  let closed = false;
  let lastUserActivity = Date.now();

  const postEvent = (role: string, content: string, status?: string) => {
    const body: Record<string, unknown> = {
      sessionId,
      role,
      content: String(content || "").slice(0, 20000),
    };
    if (status != null) body.status = status;
    postJsonFireAndForget(backend, apiKey, "/api/chimphands/post_agent_event", body);
  };

  const complete = (status: string, errorMessage?: string) => {
    const body: Record<string, unknown> = { sessionId, status };
    if (errorMessage) body.errorMessage = String(errorMessage).slice(0, 4000);
    if (githubRunId) body.githubRunId = githubRunId;
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
      queue.push(ensureTestchimpPrompt(content));
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

  let prompt = ensureTestchimpPrompt(promptInput || boot.initial_prompt || "");
  if (boot.conversation_summary) {
    prompt = `Conversation so far:\n${boot.conversation_summary}\n\nCurrent task:\n${prompt}`;
  }
  for (const m of boot.pending_user_messages || []) {
    if (m?.content) queue.push(ensureTestchimpPrompt(m.content));
  }

  const waitForNextPrompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      const tick = () => {
        if (queue.length) {
          resolve(ensureTestchimpPrompt(queue.shift()!));
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
    const result = await runOpencode(
      ensureTestchimpPrompt(prompt),
      opencodeModel,
      childEnv,
      postEvent,
    );
    if (result.code !== 0) {
      const errMsg = (result.err || "opencode failed").trim() || "opencode failed";
      console.error(`ChimpHands OpenCode failed: ${errMsg}`);
      try {
        await postJson(backend, apiKey, "/api/chimphands/post_agent_event", {
          sessionId,
          role: ROLE_STATUS,
          content: errMsg,
          status: STATUS_FAILED,
          githubRunId: githubRunId || undefined,
        });
        await postJson(backend, apiKey, "/api/chimphands/complete_session", {
          sessionId,
          status: STATUS_FAILED,
          errorMessage: errMsg,
          githubRunId: githubRunId || undefined,
        });
      } catch (reportErr: unknown) {
        const detail = reportErr instanceof Error ? reportErr.message : String(reportErr);
        console.error(`ChimpHands failed to report OpenCode error to backend: ${detail}`);
        postEvent(ROLE_STATUS, errMsg, STATUS_FAILED);
        complete(STATUS_FAILED, errMsg);
      }
      process.exit(result.code || 1);
    }
    postEvent(ROLE_STATUS, "Waiting for user input", STATUS_WAITING_USER);
    // Idle countdown starts when the agent finishes a turn, not at job bootstrap.
    lastUserActivity = Date.now();
    idle = false;
    prompt = (await waitForNextPrompt()) || "";
  }

  console.error("ChimpHands session idle — no user input before timeout; completing.");
  complete(STATUS_IDLE);
}
