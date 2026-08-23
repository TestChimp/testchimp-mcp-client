/**
 * ChimpHands GitHub Actions bridge: bootstrap → OpenCode → inbound SSE turns.
 * Relies on TESTCHIMP_API_KEY (+ optional TESTCHIMP_BACKEND_URL; defaults to prod).
 * Does not write mcp.json — TestChimp MCP is wired via opencode.json for OpenCode.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { getBackendUrl, requireApiKey } from "../core/client.js";

const ROLE_ASSISTANT = "CHIMPHANDS_MESSAGE_ROLE_ASSISTANT";
const ROLE_TOOL = "CHIMPHANDS_MESSAGE_ROLE_TOOL";
const ROLE_REASONING = "CHIMPHANDS_MESSAGE_ROLE_REASONING";
const ROLE_STATUS = "CHIMPHANDS_MESSAGE_ROLE_STATUS";

const STATUS_RUNNING = "CHIMPHANDS_SESSION_STATUS_RUNNING";
const STATUS_WAITING_USER = "CHIMPHANDS_SESSION_STATUS_WAITING_USER";
const STATUS_IDLE = "CHIMPHANDS_SESSION_STATUS_IDLE";
const STATUS_FAILED = "CHIMPHANDS_SESSION_STATUS_FAILED";

const OPENCODE_AGENT_ID = "chimphands";
const STREAM_POST_MIN_INTERVAL_MS = 60;

const CHIMPHANDS_AGENT_PROMPT = `You are ChimpHands, TestChimp's cloud coding agent running in GitHub Actions.

## Repo changes (mandatory)
- NEVER commit or push directly to the default branch (main/master).
- This conversation uses ONE working branch and ONE pull request. Reuse them for all follow-up work in this chat.
- If bootstrap lists a working branch, checkout that branch and push additional commits there — update the same PR.
- Only create a NEW branch/PR when (a) no working branch exists yet for this conversation, or (b) the prior PR was merged/closed (verify with \`gh pr view\`).
- Branch names MUST start with \`testchimp-\` or \`chimphands-\`.
- After creating a branch or opening a PR, IMMEDIATELY run:
  \`testchimp chimphands report-branch --branch <name> [--pr-url <url>]\`
- Tell the user which branch you are on and include the PR URL when available.

## TestChimp workflows (/testchimp …)
- Load and follow the \`testchimp\` skill under \`.agents/skills/testchimp/SKILL.md\`.
- For any /testchimp command: use TestChimp MCP tools (preferred) or \`testchimp\` CLI — never invent API results.
- Follow plan → explicit user approval → execute. Do not skip MCP calls or claim done without tool evidence.
- Export \`TESTCHIMP_EXECUTION_SOURCE=CLOUD_AGENT\` before Playwright/Mobilewright runs.

## Honesty
- If MCP/tools fail, report the error. Never narrate success without tool output or a PR link when repo changes were needed.`;

function normalizeUserMessage(content: string): string {
  return content.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type InboundUserMessage = {
  id?: string;
  content?: string;
};

type BootstrapResponse = {
  session_id?: string;
  llm_base_url?: string;
  llm_api_key?: string;
  llm_model?: string;
  initial_prompt?: string;
  conversation_summary?: string;
  idle_timeout_seconds?: number;
  chimphands_service_account_user_id?: string;
  opencode_session_id?: string;
  working_branch?: string;
  pull_request_url?: string;
  working_branch_url?: string;
  pending_user_messages?: Array<{ content?: string }>;
};

export type ReportWorkingBranchOptions = {
  sessionId: string;
  branch: string;
  pullRequestUrl?: string;
};

/** Agent/CLI hook: persist the conversation working branch (+ optional PR) for UI + later turns. */
export async function reportWorkingBranch(opts: ReportWorkingBranchOptions): Promise<void> {
  const apiKey = requireApiKey();
  const backend = getBackendUrl();
  const branch = opts.branch.trim();
  if (!branch) {
    throw new Error("branch is required");
  }
  const body: Record<string, unknown> = {
    sessionId: opts.sessionId.trim(),
    workingBranch: branch,
  };
  const pr = opts.pullRequestUrl?.trim();
  if (pr) body.pullRequestUrl = pr;
  await postJson(backend, apiKey, "/api/chimphands/post_agent_event", body);
}

type RunOptions = {
  sessionId: string;
  prompt?: string;
};

type PostEventOptions = {
  status?: string;
  messageId?: string;
  opencodeSessionId?: string;
  workingBranch?: string;
  pullRequestUrl?: string;
  /** When true, coalesce rapid assistant/reasoning chunks (still persisted in order). */
  throttle?: boolean;
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

/** Serializes post_agent_event calls so streaming chunks commit and fan out in order. */
class AgentEventPoster {
  private chain: Promise<void> = Promise.resolve();
  private lastStreamPostAt = 0;

  constructor(
    private readonly backend: string,
    private readonly apiKey: string,
    private readonly sessionId: string,
  ) {}

  enqueue(
    role: string,
    content: string,
    opts?: PostEventOptions,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      sessionId: this.sessionId,
      role,
      content: String(content || "").slice(0, 20000),
    };
    if (opts?.messageId) body.messageId = opts.messageId;
    if (opts?.status != null) body.status = opts.status;
    if (opts?.opencodeSessionId) body.opencodeSessionId = opts.opencodeSessionId;
    if (opts?.workingBranch) body.workingBranch = opts.workingBranch;
    if (opts?.pullRequestUrl) body.pullRequestUrl = opts.pullRequestUrl;

    this.chain = this.chain.then(async () => {
      if (opts?.throttle) {
        const now = Date.now();
        const wait = STREAM_POST_MIN_INTERVAL_MS - (now - this.lastStreamPostAt);
        if (wait > 0) await sleep(wait);
        this.lastStreamPostAt = Date.now();
      }
      await postJson(this.backend, this.apiKey, "/api/chimphands/post_agent_event", body);
    });
    return this.chain;
  }

  fireAndForget(role: string, content: string, opts?: PostEventOptions): void {
    void this.enqueue(role, content, opts).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`ChimpHands API telemetry failed: ${detail}`);
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }

  reportWorkingBranch(branch: string, pullRequestUrl?: string): void {
    this.chain = this.chain.then(async () => {
      const body: Record<string, unknown> = {
        sessionId: this.sessionId,
        workingBranch: branch,
      };
      if (pullRequestUrl?.trim()) body.pullRequestUrl = pullRequestUrl.trim();
      await postJson(this.backend, this.apiKey, "/api/chimphands/post_agent_event", body);
    });
    void this.chain.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`ChimpHands report-branch failed: ${detail}`);
    });
  }
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
      error?: { name?: string; message?: string; data?: { message?: string } };
    };
    if (ev.type === "error" || ev.name === "UnknownError") {
      const msg =
        ev.error?.data?.message ||
        ev.error?.message ||
        ev.data?.message ||
        ev.message ||
        line;
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

type OpencodePart = {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    output?: string;
    input?: Record<string, unknown>;
  };
};

type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  part?: OpencodePart;
  error?: { name?: string; message?: string; data?: { message?: string } };
};

function parseOpencodeEvent(line: string): OpencodeEvent | null {
  try {
    return JSON.parse(line) as OpencodeEvent;
  } catch {
    return null;
  }
}

function formatToolUseContent(part: OpencodePart): string {
  const title = part.state?.title || part.tool || "tool";
  const status = part.state?.status?.trim();
  const input = part.state?.input;
  const inputText =
    input && Object.keys(input).length
      ? `\nInput: ${JSON.stringify(input).slice(0, 4000)}`
      : "";
  const output = part.state?.output?.trim();
  const statusLine = status ? `[${title}] (${status})` : `[${title}]`;
  if (output) return `${statusLine}\n${output}`;
  if (inputText) return `${statusLine}${inputText}`;
  return statusLine;
}

function opencodeMessageId(prefix: string, part?: OpencodePart): string | undefined {
  const raw = part?.id || part?.messageID;
  if (!raw) return undefined;
  return `${prefix}${raw}`;
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

function isMissingOpencodeSessionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    (m.includes("session") && m.includes("not found")) ||
    m.includes("unknown session") ||
    m.includes("invalid session")
  );
}

function wrapPromptWithContext(
  conversationSummary: string,
  userPrompt: string,
  isNewOpencodeSession: boolean,
  workingBranch?: string,
  pullRequestUrl?: string,
): string {
  const parts: string[] = [];
  if (workingBranch?.trim()) {
    parts.push(
      "## Conversation working branch (reuse for this thread)",
      `Branch: \`${workingBranch.trim()}\``,
      pullRequestUrl?.trim() ? `PR: ${pullRequestUrl.trim()}` : "",
      "Checkout this branch, commit and push here. Do NOT open a new PR unless the one above was merged/closed.",
      "",
    );
  }
  const task = normalizeUserMessage(userPrompt);
  if (isNewOpencodeSession && conversationSummary.trim()) {
    parts.push(`Conversation so far:\n${conversationSummary.trim()}`, "", `Current task:\n${task}`);
    return parts.filter(Boolean).join("\n");
  }
  if (parts.length) {
    parts.push(`Current task:\n${task}`);
    return parts.filter(Boolean).join("\n");
  }
  return task;
}

function detectWorkingBranchFromToolOutput(output: string): { branch?: string; pullRequestUrl?: string } {
  const text = output.trim();
  if (!text) return {};
  const prMatch = text.match(/https:\/\/github\.com\/[^\s)\]]+\/pull\/\d+/);
  const checkoutMatch = text.match(/checkout\s+-b\s+((?:testchimp-|chimphands-)[^\s'"]+)/i);
  const pushMatch = text.match(/push\s+(?:--set-upstream\s+|-u\s+)?origin\s+((?:testchimp-|chimphands-)[^\s'"]+)/i);
  const branchMatch = text.match(/branch['":\s]+((?:testchimp-|chimphands-)[^\s'"]+)/i);
  const branch = (checkoutMatch?.[1] || pushMatch?.[1] || branchMatch?.[1])?.replace(/[`'"]/g, "");
  return {
    branch,
    pullRequestUrl: prMatch?.[0],
  };
}

function writeOpencodeConfig(backend: string, apiKey: string, boot: BootstrapResponse): string {
  const llmBase = (boot.llm_base_url || `${backend}/v1`).replace(/\/$/, "");
  const llmKey = apiKey || boot.llm_api_key || "";
  const modelId = resolveOpencodeModelId(boot);
  const model = `${TESTCHIMP_PROVIDER_ID}/${modelId}`;
  const mcpEnv: Record<string, string> = {
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
    TESTCHIMP_EXECUTION_SOURCE: "CLOUD_AGENT",
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
        default_agent: OPENCODE_AGENT_ID,
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
        agent: {
          [OPENCODE_AGENT_ID]: {
            mode: "primary",
            description: "TestChimp ChimpHands cloud agent (PR-only repo writes)",
            prompt: CHIMPHANDS_AGENT_PROMPT,
            steps: 80,
            permission: {
              skill: "allow",
              bash: "allow",
              edit: "allow",
              read: "allow",
            },
          },
        },
        skills: {
          paths: [".agents/skills/testchimp"],
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

type RunOpencodeCallbacks = {
  onSessionId?: (sessionId: string) => void;
  onWorkingBranch?: (branch: string, pullRequestUrl?: string) => void;
  postEvent: (role: string, content: string, opts?: PostEventOptions) => void;
};

function buildOpencodeArgs(prompt: string, model: string, opencodeSessionId?: string): string[] {
  const args = ["run", prompt, "--model", model, "--format", "json", "--agent", OPENCODE_AGENT_ID];
  if (opencodeSessionId?.trim()) {
    args.push("--session", opencodeSessionId.trim());
  }
  return args;
}

function runOpencode(
  prompt: string,
  model: string,
  childEnv: NodeJS.ProcessEnv,
  opencodeSessionId: string | undefined,
  callbacks: RunOpencodeCallbacks,
): Promise<{ code: number; err: string; opencodeSessionId?: string }> {
  let activeSessionId = opencodeSessionId?.trim() || undefined;
  const baseArgs = buildOpencodeArgs(prompt, model, activeSessionId);

  const child = spawn("opencode", baseArgs, {
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
    const textByPartId = new Map<string, string>();

    const noteSessionId = (sessionId?: string) => {
      const id = sessionId?.trim();
      if (!id || id === activeSessionId) return;
      activeSessionId = id;
      callbacks.onSessionId?.(id);
    };

    const handleOpencodeLine = (line: string) => {
      if (!line.trim()) return;
      const fatal = extractOpencodeFatalError(line);
      if (fatal) {
        fatalError = fatal;
        return;
      }
      const ev = parseOpencodeEvent(line);
      if (!ev?.type) return;
      noteSessionId(ev.sessionID);

      switch (ev.type) {
        case "text": {
          const chunk = ev.part?.text;
          if (!chunk) return;
          const partId = ev.part?.id || ev.part?.messageID;
          if (!partId) {
            callbacks.postEvent(ROLE_ASSISTANT, chunk, { throttle: true });
            return;
          }
          const next = (textByPartId.get(partId) || "") + chunk;
          textByPartId.set(partId, next);
          callbacks.postEvent(ROLE_ASSISTANT, next, {
            throttle: true,
            messageId: opencodeMessageId("oc_text_", ev.part),
          });
          return;
        }
        case "reasoning": {
          const chunk = ev.part?.text;
          if (!chunk) return;
          const partId = ev.part?.id || ev.part?.messageID;
          if (!partId) {
            callbacks.postEvent(ROLE_REASONING, chunk, { throttle: true });
            return;
          }
          const reasoningKey = `reasoning:${partId}`;
          const next = (textByPartId.get(reasoningKey) || "") + chunk;
          textByPartId.set(reasoningKey, next);
          callbacks.postEvent(ROLE_REASONING, next, {
            throttle: true,
            messageId: opencodeMessageId("oc_reasoning_", ev.part),
          });
          return;
        }
        case "tool_use": {
          const status = ev.part?.state?.status;
          if (!status || status === "pending") return;
          const toolContent = formatToolUseContent(ev.part!);
          callbacks.postEvent(ROLE_TOOL, toolContent, {
            messageId: opencodeMessageId("oc_tool_", ev.part),
          });
          if (status === "completed") {
            const detected = detectWorkingBranchFromToolOutput(toolContent);
            if (detected.branch) {
              callbacks.onWorkingBranch?.(detected.branch, detected.pullRequestUrl);
            }
          }
          return;
        }
        case "error": {
          const msg =
            ev.error?.data?.message ||
            ev.error?.message ||
            line.trim();
          if (msg) fatalError = msg;
          return;
        }
        case "step_start":
        case "step_finish":
          return;
        default:
          return;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        handleOpencodeLine(line);
      }
    });

    child.on("close", (code) => {
      if (buf.trim()) {
        handleOpencodeLine(buf.trim());
      }
      const stderrFatal = extractOpencodeFatalError(err);
      if (stderrFatal) fatalError = stderrFatal;
      if (fatalError) {
        resolve({ code: 1, err: fatalError, opencodeSessionId: activeSessionId });
        return;
      }
      if (code != null && code !== 0) {
        resolve({
          code,
          err: summarizeOpencodeFailure(err, buf, code),
          opencodeSessionId: activeSessionId,
        });
        return;
      }
      resolve({ code: code == null ? 1 : code, err, opencodeSessionId: activeSessionId });
    });
  });
}

function connectInboundStream(
  backend: string,
  apiKey: string,
  sessionId: string,
  handlers: {
    onUserMessage: (msg: InboundUserMessage) => void;
    onIdle: () => void;
    shouldRun: () => boolean;
  },
): () => void {
  const url = new URL(`${backend}/api/chimphands/sessions/${encodeURIComponent(sessionId)}/inbound`);
  const lib = url.protocol === "https:" ? https : http;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;

  const scheduleReconnect = () => {
    if (stopped || !handlers.shouldRun()) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15_000);
  };

  const connect = () => {
    if (stopped || !handlers.shouldRun()) return;
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
        reconnectDelayMs = 1000;
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
                handlers.onIdle();
              } else if (eventName === "user_message" || eventName === "message") {
                try {
                  const msg = JSON.parse(data) as {
                    id?: string;
                    message_id?: string;
                    content?: string;
                  };
                  handlers.onUserMessage({
                    id: msg.id || msg.message_id,
                    content: msg.content || "",
                  });
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
        res.on("end", () => scheduleReconnect());
      },
    );
    req.on("error", () => scheduleReconnect());
    req.end();
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}

export async function runChimphands(opts: RunOptions): Promise<void> {
  const apiKey = requireApiKey();
  const backend = getBackendUrl();
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
  const poster = new AgentEventPoster(backend, apiKey, sessionId);

  if (githubRunId) {
    await postJson(backend, apiKey, "/api/chimphands/post_agent_event", {
      sessionId,
      githubRunId,
    }).catch((err: unknown) => {
      console.error(`ChimpHands link run failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const userId = boot.chimphands_service_account_user_id || "";
  if (userId) {
    process.env.TESTCHIMP_USER_ID = userId;
  }

  mkdirSync(".opencode", { recursive: true });
  const opencodeModel = writeOpencodeConfig(backend, apiKey, boot);
  console.error(`ChimpHands OpenCode model: ${opencodeModel}`);

  let opencodeSessionId = boot.opencode_session_id?.trim() || undefined;
  const conversationSummary = boot.conversation_summary || "";
  let workingBranch = boot.working_branch?.trim() || undefined;
  let pullRequestUrl = boot.pull_request_url?.trim() || undefined;

  const noteWorkingBranch = (branch: string, prUrl?: string) => {
    const normalizedBranch = branch.trim();
    if (!normalizedBranch) return;
    const branchIsNew = !workingBranch;
    const nextPr = prUrl?.trim() || pullRequestUrl;
    const prIsNew = !!prUrl?.trim() && prUrl.trim() !== pullRequestUrl;
    if (workingBranch === normalizedBranch && !prIsNew) return;
    workingBranch = normalizedBranch;
    if (prUrl?.trim()) pullRequestUrl = prUrl.trim();
    if (branchIsNew || prIsNew) {
      poster.reportWorkingBranch(normalizedBranch, nextPr);
    }
  };

  const idleMs = (Number(boot.idle_timeout_seconds) || 600) * 1000;
  const queue: string[] = [];
  const seenUserMessageIds = new Set<string>();
  let idle = false;
  let sessionActive = true;
  let lastUserActivity = Date.now();

  const enqueueUserMessage = (msg: InboundUserMessage) => {
    const id = msg.id?.trim();
    if (id) {
      if (seenUserMessageIds.has(id)) return;
      seenUserMessageIds.add(id);
    }
    const content = normalizeUserMessage(msg.content || "");
    if (!content) return;
    queue.push(content);
    lastUserActivity = Date.now();
    idle = false;
  };

  const pollPendingUserMessages = async () => {
    try {
      const text = await postJson(backend, apiKey, "/api/chimphands/consume_pending_user_messages", {
        sessionId,
      });
      const data = JSON.parse(text) as {
        messages?: Array<{ id?: string; message_id?: string; content?: string }>;
      };
      for (const msg of data.messages || []) {
        enqueueUserMessage({
          id: msg.id || msg.message_id,
          content: msg.content || "",
        });
      }
    } catch {
      // Polling is best-effort when inbound SSE misses an event.
    }
  };

  const postEvent = (role: string, content: string, opts?: PostEventOptions) => {
    const bodyOpts: PostEventOptions = { ...opts };
    if (opencodeSessionId && !bodyOpts.opencodeSessionId) {
      bodyOpts.opencodeSessionId = opencodeSessionId;
    }
    poster.fireAndForget(role, content, bodyOpts);
  };

  const complete = (status: string, errorMessage?: string) => {
    const body: Record<string, unknown> = { sessionId, status };
    if (errorMessage) body.errorMessage = String(errorMessage).slice(0, 4000);
    if (githubRunId) body.githubRunId = githubRunId;
    void postJson(backend, apiKey, "/api/chimphands/complete_session", body).catch((err: unknown) => {
      console.error(`ChimpHands complete_session failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
    TESTCHIMP_EXECUTION_SOURCE: "CLOUD_AGENT",
  };
  if (userId) childEnv.TESTCHIMP_USER_ID = userId;

  const stopInbound = connectInboundStream(backend, apiKey, sessionId, {
    onUserMessage: enqueueUserMessage,
    onIdle: () => {
      idle = true;
    },
    shouldRun: () => sessionActive,
  });

  poster.fireAndForget(ROLE_STATUS, "Agent ready", { status: STATUS_RUNNING });

  let prompt = normalizeUserMessage(promptInput || boot.initial_prompt || "");
  for (const m of boot.pending_user_messages || []) {
    if (m?.content) enqueueUserMessage({ content: m.content });
  }

  const waitForNextPrompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      let lastPollAt = 0;
      const tick = () => {
        if (queue.length) {
          resolve(normalizeUserMessage(queue.shift()!));
          return;
        }
        const now = Date.now();
        if (now - lastPollAt >= 1500) {
          lastPollAt = now;
          void pollPendingUserMessages().then(() => {
            if (queue.length) {
              resolve(normalizeUserMessage(queue.shift()!));
              return;
            }
            if (idle || now - lastUserActivity >= idleMs) {
              resolve(null);
              return;
            }
            setTimeout(tick, 500);
          });
          return;
        }
        if (idle || now - lastUserActivity >= idleMs) {
          resolve(null);
          return;
        }
        setTimeout(tick, 500);
      };
      tick();
    });

  while (prompt) {
    let useOpencodeSessionId = opencodeSessionId;
    let isNewOpencodeSession = !useOpencodeSessionId;
    let effectivePrompt = wrapPromptWithContext(
      conversationSummary,
      prompt,
      isNewOpencodeSession,
      workingBranch,
      pullRequestUrl,
    );

    let result = await runOpencode(effectivePrompt, opencodeModel, childEnv, useOpencodeSessionId, {
      onSessionId: (id) => {
        opencodeSessionId = id;
        void postJson(backend, apiKey, "/api/chimphands/post_agent_event", {
          sessionId,
          opencodeSessionId: id,
        }).catch(() => {});
      },
      onWorkingBranch: noteWorkingBranch,
      postEvent,
    });

    if (
      result.code !== 0 &&
      useOpencodeSessionId &&
      isMissingOpencodeSessionError(result.err || "")
    ) {
      console.error(
        `ChimpHands OpenCode session ${useOpencodeSessionId} missing on runner; starting fresh thread.`,
      );
      opencodeSessionId = undefined;
      isNewOpencodeSession = true;
      effectivePrompt = wrapPromptWithContext(conversationSummary, prompt, true, workingBranch, pullRequestUrl);
      result = await runOpencode(effectivePrompt, opencodeModel, childEnv, undefined, {
        onSessionId: (id) => {
          opencodeSessionId = id;
          void postJson(backend, apiKey, "/api/chimphands/post_agent_event", {
            sessionId,
            opencodeSessionId: id,
          }).catch(() => {});
        },
        onWorkingBranch: noteWorkingBranch,
        postEvent,
      });
    }

    await poster.flush();

    if (result.opencodeSessionId) {
      opencodeSessionId = result.opencodeSessionId;
    }

    if (result.code !== 0) {
      const errMsg = (result.err || "opencode failed").trim() || "opencode failed";
      console.error(`ChimpHands OpenCode failed: ${errMsg}`);
      try {
        await poster.enqueue(ROLE_STATUS, errMsg, {
          status: STATUS_FAILED,
          opencodeSessionId,
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
        postEvent(ROLE_STATUS, errMsg, { status: STATUS_FAILED });
        complete(STATUS_FAILED, errMsg);
      }
      process.exit(result.code || 1);
    }

    postEvent(ROLE_STATUS, "Waiting for user input", { status: STATUS_WAITING_USER });
    lastUserActivity = Date.now();
    idle = false;
    prompt = (await waitForNextPrompt()) || "";
  }

  sessionActive = false;
  stopInbound();
  await poster.flush();
  console.error("ChimpHands session idle — no user input before timeout; completing.");
  complete(STATUS_IDLE);
}
