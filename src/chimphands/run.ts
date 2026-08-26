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

const CHIMPHANDS_AGENT_PROMPT = `You are ChimpHands, TestChimp's coding agent. You run on GitHub Actions, but this chat is an **interactive** conversation with the user in the TestChimp UI — same expectations as Cursor/Claude Code locally.

## Interactive session (mandatory — default)
- Default mode is **interactive**. Ask clarifying questions, seek plan approval, and wait for the user's reply — just as you would in Cursor.
- \`GITHUB_ACTIONS\`, \`CLOUD_AGENT\`, and "running in CI" mean **where** you execute (runner + \`TESTCHIMP_EXECUTION_SOURCE\`). They do **NOT** mean skip questions, invent defaults, or auto-approve.
- Only treat the run as non-interactive when the **user prompt** literally includes \`--mode=non-interactive\` (or \`mode=non-interactive\`), or the resolved skill policy explicitly sets \`allow-execute-without-approval\`.
- When you need clarification (e.g. import plans/tests, env strategy, CI choices) or plan approval: write the questions / plan summary as assistant text, then **stop this turn**. Do not invent answers or continue into Execute. The host will wait for the next chat message and revive you.
- Prefer a short numbered list of concrete questions over a long monologue. One decision gate at a time when possible (especially \`/testchimp project init\` Phase 1).

## Repo changes (mandatory)
- NEVER commit or push directly to the default branch (main/master).
- This conversation uses ONE working branch and ONE pull request. Reuse them for all follow-up work in this chat.
- If bootstrap lists a working branch, checkout that branch and push additional commits there — update the same PR.
- Only create a NEW branch/PR when (a) no working branch exists yet for this conversation, or (b) the prior PR was merged/closed (verify with \`gh pr view\`).
- Commit and push on the session working branch after meaningful edit batches. The host also commits any dirty worktree before idle teardown — keep the branch pushed so the UI can show diffs from GitHub.
- Branch names MUST start with \`testchimp-\` or \`chimphands-\`.
- When creating a NEW working branch: create it, then IMMEDIATELY publish it with
  \`git push -u origin <branch>\` BEFORE calling report-branch. Users open the branch URL in the UI —
  do not report a branch that only exists locally (that causes GitHub 404).
- After the branch is on the remote (and after opening a PR), IMMEDIATELY run:
  \`testchimp chimphands report-branch --branch <name> [--pr-url <url>]\`
- Tell the user which branch you are on and include the PR URL when available.

## TestChimp workflows (/testchimp …)
- Load and follow the \`testchimp\` skill under \`.agents/skills/testchimp/SKILL.md\`.
- For any /testchimp command: use TestChimp MCP tools (preferred) or \`testchimp\` CLI — never invent API results.
- Follow plan → explicit user approval → execute (interactive default). Do not skip MCP calls or claim done without tool evidence.
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
  sessionId?: string;
  llm_base_url?: string;
  llmBaseUrl?: string;
  llm_api_key?: string;
  llmApiKey?: string;
  llm_model?: string;
  llmModel?: string;
  initial_prompt?: string;
  initialPrompt?: string;
  conversation_summary?: string;
  conversationSummary?: string;
  idle_timeout_seconds?: number;
  idleTimeoutSeconds?: number;
  chimphands_service_account_user_id?: string;
  chimphandsServiceAccountUserId?: string;
  opencode_session_id?: string;
  opencodeSessionId?: string;
  working_branch?: string;
  workingBranch?: string;
  pull_request_url?: string;
  pullRequestUrl?: string;
  working_branch_url?: string;
  workingBranchUrl?: string;
  pending_user_messages?: Array<{ content?: string }>;
  pendingUserMessages?: Array<{ content?: string }>;
};

/** Protobuf JsonFormat uses camelCase; accept snake_case too for resilience. */
function bootStr(boot: BootstrapResponse, snake: string, camel: string): string {
  const raw = boot as Record<string, unknown>;
  const v = raw[snake] ?? raw[camel];
  return typeof v === "string" ? v.trim() : "";
}

function bootNum(boot: BootstrapResponse, snake: string, camel: string): number | undefined {
  const raw = boot as Record<string, unknown>;
  const v = raw[snake] ?? raw[camel];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

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
  /** When set, `opencode run --attach` to a local OpenCode server. */
  attachUrl?: string;
  /** Registered runtime id (from register_runtime); enables heartbeat + tunnel + complete_runtime. */
  runtimeId?: string;
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
  const raw = bootStr(boot, "llm_model", "llmModel") || "gpt-5.6-luna";
  const modelId = raw.includes("/") ? raw.split("/").pop() || "gpt-5.6-luna" : raw;
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

function isNonInteractivePrompt(userPrompt: string): boolean {
  return /(?:^|\s)--mode\s*=?\s*non-interactive\b|mode\s*=\s*non-interactive\b/i.test(
    userPrompt,
  );
}

function isTestchimpWorkflowPrompt(userPrompt: string): boolean {
  return /(?:^|\s)\/?testchimp\b/i.test(userPrompt.trim());
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
  if (isTestchimpWorkflowPrompt(task) && !isNonInteractivePrompt(task)) {
    parts.push(
      "## Interactive turn reminder",
      "This is an interactive ChimpHands chat (not autonomous CI). Ask clarifying questions / seek plan approval, then end the turn and wait — do not invent defaults or Execute until the user replies. Only `--mode=non-interactive` skips that pause.",
      "",
    );
  }
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
  // Only auto-detect after a successful push to origin — local checkout -b alone would
  // report a branch URL that 404s until the remote ref exists.
  const pushMatch = text.match(
    /push\s+(?:--set-upstream\s+|-u\s+)?origin\s+((?:testchimp-|chimphands-)[^\s'"]+)/i
  );
  const branch = pushMatch?.[1]?.replace(/[`'"]/g, "");
  return {
    branch,
    pullRequestUrl: prMatch?.[0],
  };
}

function writeOpencodeConfig(backend: string, apiKey: string, boot: BootstrapResponse): string {
  const llmBase = (bootStr(boot, "llm_base_url", "llmBaseUrl") || `${backend}/v1`).replace(/\/$/, "");
  const llmKey = apiKey || bootStr(boot, "llm_api_key", "llmApiKey");
  const modelId = resolveOpencodeModelId(boot);
  const model = `${TESTCHIMP_PROVIDER_ID}/${modelId}`;
  const sessionId = bootStr(boot, "session_id", "sessionId");
  const mcpEnv: Record<string, string> = {
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
    TESTCHIMP_EXECUTION_SOURCE: "CLOUD_AGENT",
  };
  const serviceUserId = bootStr(boot, "chimphands_service_account_user_id", "chimphandsServiceAccountUserId");
  if (serviceUserId) {
    mcpEnv.TESTCHIMP_USER_ID = serviceUserId;
  }
  const providerOptions: Record<string, unknown> = {
    apiKey: llmKey,
    baseURL: llmBase,
  };
  if (sessionId) {
    providerOptions.headers = {
      "X-TestChimp-ChimpHands-Session-Id": sessionId,
    };
  }
  // @ai-sdk/openai uses /v1/responses (tools + reasoning). openai-compatible is chat-only.
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
            npm: "@ai-sdk/openai",
            name: "TestChimp",
            options: providerOptions,
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

function buildOpencodeArgs(
  prompt: string,
  model: string,
  opencodeSessionId?: string,
  attachUrl?: string,
): string[] {
  const args = ["run", prompt, "--model", model, "--format", "json", "--agent", OPENCODE_AGENT_ID];
  if (opencodeSessionId?.trim()) {
    args.push("--session", opencodeSessionId.trim());
  }
  if (attachUrl?.trim()) {
    args.push("--attach", attachUrl.trim());
  }
  return args;
}

function runOpencode(
  prompt: string,
  model: string,
  childEnv: NodeJS.ProcessEnv,
  opencodeSessionId: string | undefined,
  callbacks: RunOpencodeCallbacks,
  attachUrl?: string,
): Promise<{ code: number; err: string; opencodeSessionId?: string }> {
  let activeSessionId = opencodeSessionId?.trim() || undefined;
  const baseArgs = buildOpencodeArgs(prompt, model, activeSessionId, attachUrl);

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
  const attachUrl = (opts.attachUrl || process.env.OPENCODE_ATTACH_URL || "").trim() || undefined;
  let runtimeId = (opts.runtimeId || process.env.CHIMPHANDS_RUNTIME_ID || "").trim() || undefined;

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

  if (!runtimeId && attachUrl) {
    try {
      const regText = await postJson(backend, apiKey, "/api/chimphands/register_runtime", {
        sessionId,
        location: "CHIMPHANDS_RUNTIME_LOCATION_GITHUB_CI",
        githubRunId: githubRunId || undefined,
      });
      const reg = JSON.parse(regText) as { runtime?: { id?: string }; runtimeId?: string };
      runtimeId = reg.runtime?.id || reg.runtimeId || undefined;
      if (runtimeId) {
        console.error(`ChimpHands runtime registered: ${runtimeId}`);
        process.env.CHIMPHANDS_RUNTIME_ID = runtimeId;
      }
    } catch (err: unknown) {
      console.error(
        `ChimpHands register_runtime failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const stopHeartbeat = runtimeId
    ? startRuntimeHeartbeat(backend, apiKey, runtimeId)
    : () => {};
  const stopTunnel = runtimeId && attachUrl
    ? startTunnelWorker(backend, apiKey, runtimeId, attachUrl)
    : () => {};

  const userId = bootStr(boot, "chimphands_service_account_user_id", "chimphandsServiceAccountUserId");
  if (userId) {
    process.env.TESTCHIMP_USER_ID = userId;
  }

  mkdirSync(".opencode", { recursive: true });
  const opencodeModel = writeOpencodeConfig(backend, apiKey, boot);
  console.error(`ChimpHands OpenCode model: ${opencodeModel}`);
  if (attachUrl) {
    console.error(`ChimpHands OpenCode attach: ${attachUrl}`);
  }

  let opencodeSessionId = bootStr(boot, "opencode_session_id", "opencodeSessionId") || undefined;
  const conversationSummary = bootStr(boot, "conversation_summary", "conversationSummary");
  let workingBranch = bootStr(boot, "working_branch", "workingBranch") || undefined;
  let pullRequestUrl = bootStr(boot, "pull_request_url", "pullRequestUrl") || undefined;

  const exportSignedUrl = bootStr(boot, "opencode_export_signed_url", "opencodeExportSignedUrl");
  if (exportSignedUrl && attachUrl) {
    try {
      const importedId = await importOpencodeExportFromUrl(exportSignedUrl);
      if (importedId) {
        opencodeSessionId = importedId;
        console.error(`ChimpHands rehydrated OpenCode session from export: ${importedId}`);
      }
    } catch (err: unknown) {
      console.error(
        `ChimpHands export import failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const snapshotExport = async () => {
    const sid = opencodeSessionId?.trim();
    if (!sid) return;
    try {
      await putOpencodeExport(backend, apiKey, sessionId, sid);
    } catch (err: unknown) {
      console.error(
        `ChimpHands export snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

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

  const idleMs = (bootNum(boot, "idle_timeout_seconds", "idleTimeoutSeconds") || 600) * 1000;
  const queue: string[] = [];
  const seenUserMessageIds = new Set<string>();
  let idle = false;
  let sessionActive = true;
  let lastUserActivity = Date.now();
  let exitCode: number | undefined;

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

  const shutdownRuntime = async () => {
    sessionActive = false;
    stopInbound();
    stopTunnel();
    stopHeartbeat();
    await commitAndPushDirtyWorktree("chimphands: commit before session idle/shutdown");
    await poster.flush();
    await snapshotExport();
    if (runtimeId) {
      await postJson(backend, apiKey, "/api/chimphands/complete_runtime", {
        runtimeId,
        status: "CHIMPHANDS_RUNTIME_STATUS_TERMINATED",
      }).catch(() => {});
    }
  };

  try {
  poster.fireAndForget(ROLE_STATUS, "Agent ready", { status: STATUS_RUNNING });

  let prompt = normalizeUserMessage(promptInput || bootStr(boot, "initial_prompt", "initialPrompt"));
  const pending =
    boot.pending_user_messages || boot.pendingUserMessages || [];
  for (const m of pending) {
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
    }, attachUrl);

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
      }, attachUrl);
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
      exitCode = result.code || 1;
      break;
    }

    postEvent(ROLE_STATUS, "Waiting for user input", { status: STATUS_WAITING_USER });
    await snapshotExport();
    lastUserActivity = Date.now();
    idle = false;
    prompt = (await waitForNextPrompt()) || "";
  }

  if (exitCode == null) {
    console.error("ChimpHands session idle — no user input before timeout; completing.");
    complete(STATUS_IDLE);
  }
  } finally {
    await shutdownRuntime();
  }
  if (exitCode != null) {
    process.exit(exitCode);
  }
}

function startRuntimeHeartbeat(backend: string, apiKey: string, runtimeId: string): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      // Do not claim tunnel_connected here — only the tunnel poll loop should.
      await postJson(backend, apiKey, "/api/chimphands/runtime_heartbeat", {
        runtimeId,
      });
    } catch (err: unknown) {
      console.error(
        `ChimpHands runtime_heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!stopped) setTimeout(tick, 15_000);
  };
  void tick();
  return () => {
    stopped = true;
  };
}

/** Commit+push dirty worktree on the session branch before idle/teardown (no default-branch writes). */
async function commitAndPushDirtyWorktree(message: string): Promise<void> {
  const run = (args: string[], env?: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn("git", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: env ? { ...process.env, ...env } : process.env,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    });

  try {
    const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0) {
      console.error(`ChimpHands git rev-parse failed: ${branch.err || branch.out}`);
      return;
    }
    const current = branch.out.trim();
    if (!current || current === "HEAD" || /^(main|master)$/i.test(current)) {
      console.error(
        `ChimpHands skip commit-before-idle: refusing branch "${current || "(unknown)"}"`,
      );
      return;
    }

    const status = await run(["status", "--porcelain"]);
    if (status.code !== 0) {
      console.error(`ChimpHands git status failed: ${status.err || status.out}`);
      return;
    }
    if (!status.out.trim()) {
      return;
    }
    const add = await run(["add", "-A"]);
    if (add.code !== 0) {
      console.error(`ChimpHands git add failed: ${add.err || add.out}`);
      return;
    }
    const commitEnv = {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "ChimpHands",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "chimphands@testchimp.io",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "ChimpHands",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "chimphands@testchimp.io",
    };
    const commit = await run(
      ["-c", "user.name=ChimpHands", "-c", "user.email=chimphands@testchimp.io", "commit", "-m", message],
      commitEnv,
    );
    if (commit.code !== 0) {
      console.error(`ChimpHands git commit: ${commit.err || commit.out}`);
      return;
    }
    const push = await run(["push", "-u", "origin", "HEAD"]);
    if (push.code !== 0) {
      console.error(`ChimpHands git push failed: ${push.err || push.out}`);
      return;
    }
    console.error(`ChimpHands committed and pushed dirty worktree on ${current} before shutdown`);
  } catch (err: unknown) {
    console.error(
      `ChimpHands commit-before-idle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function putOpencodeExport(
  backend: string,
  apiKey: string,
  sessionId: string,
  opencodeSessionId: string,
): Promise<void> {
  const exported = await new Promise<string>((resolve, reject) => {
    const child = spawn("opencode", ["export", opencodeSessionId, "--sanitize"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(err.trim() || `opencode export exited ${code}`));
    });
  });
  const exportBase64 = Buffer.from(exported, "utf8").toString("base64");
  await postJson(backend, apiKey, "/api/chimphands/put_opencode_export", {
    sessionId,
    exportBase64,
  });
}

async function importOpencodeExportFromUrl(signedUrl: string): Promise<string | undefined> {
  const res = await fetch(signedUrl);
  if (!res.ok) {
    throw new Error(`download export failed: ${res.status}`);
  }
  const text = await res.text();
  writeFileSync("/tmp/chimphands-opencode-export.json", text, "utf8");
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode", ["import", "/tmp/chimphands-opencode-export.json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `opencode import exited ${code}`));
        return;
      }
      const match = (out + "\n" + err).match(/ses_[A-Za-z0-9]+/);
      resolve(match?.[0]);
    });
  });
}

function startTunnelWorker(
  backend: string,
  apiKey: string,
  runtimeId: string,
  attachUrl: string,
): () => void {
  let stopped = false;
  const base = attachUrl.replace(/\/$/, "");
  let ws: import("ws").WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1000;

  const wsBase = backend.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws"));
  const tunnelUrl =
    `${wsBase.replace(/\/$/, "")}/api/chimphands/runtimes/${encodeURIComponent(runtimeId)}/tunnel`;

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const handleHttpRequest = async (
    socket: import("ws").WebSocket,
    req: {
      requestId?: string;
      method?: string;
      path?: string;
      query?: string;
      headers?: Record<string, string>;
      bodyBase64?: string;
    },
  ) => {
    if (!req.requestId || socket.readyState !== 1) return;
    const requestId = req.requestId;
    const target = base + (req.path || "/") + (req.query ? `?${req.query}` : "");
    const headers: Record<string, string> = { ...(req.headers || {}) };
    const init: RequestInit = { method: req.method || "GET", headers };
    if (req.bodyBase64) {
      init.body = Buffer.from(req.bodyBase64, "base64");
    }
    // Long-running SSE / chat streams — no hard abort under ~5 minutes.
    const ac = new AbortController();
    const upstreamTimer = setTimeout(() => ac.abort(), 290_000);
    init.signal = ac.signal;

    const send = (obj: Record<string, unknown>) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(obj));
    };

    /** Keep each WS text frame small — Tomcat default max is 8KiB; GCLB is happier with modest frames. */
    const sendBodyChunk = (bytes: Buffer) => {
      const MAX = 24 * 1024;
      for (let offset = 0; offset < bytes.length; offset += MAX) {
        const slice = bytes.subarray(offset, Math.min(offset + MAX, bytes.length));
        send({
          type: "http_response_chunk",
          requestId,
          bodyBase64: Buffer.from(slice).toString("base64"),
        });
      }
    };

    try {
      const upstream = await fetch(target, init);
      const respHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      send({
        type: "http_response_start",
        requestId,
        status: upstream.status,
        headers: respHeaders,
      });

      const body = upstream.body;
      if (body) {
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            sendBodyChunk(Buffer.from(value));
          }
        }
      } else {
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length) {
          sendBodyChunk(buf);
        }
      }
      send({ type: "http_response_end", requestId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      send({
        type: "http_response",
        requestId,
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        bodyBase64: Buffer.from(msg, "utf8").toString("base64"),
      });
    } finally {
      clearTimeout(upstreamTimer);
    }
  };

  const connect = async () => {
    if (stopped) return;
    clearReconnect();
    const { default: WebSocket } = await import("ws");
    const socket = new WebSocket(tunnelUrl, {
      headers: { "TestChimp-Api-Key": apiKey },
      handshakeTimeout: 30_000,
    });
    ws = socket;

    socket.on("open", () => {
      backoffMs = 1000;
      console.error(`ChimpHands agent tunnel WS connected: ${tunnelUrl}`);
      // Application ping keeps LBs from idling out the tunnel (and proves liveness).
      const ping = () => {
        if (stopped || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      };
      ping();
      const pingTimer = setInterval(ping, 20_000);
      socket.once("close", () => clearInterval(pingTimer));
    });

    socket.on("message", (data) => {
      if (stopped) return;
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const frame = JSON.parse(text) as {
          type?: string;
          requestId?: string;
          method?: string;
          path?: string;
          query?: string;
          headers?: Record<string, string>;
          bodyBase64?: string;
        };
        if (frame.type === "pong") return;
        if (frame.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (frame.type === "http_request" || frame.requestId) {
          void handleHttpRequest(socket, frame);
        }
      } catch (err: unknown) {
        console.error(
          `ChimpHands tunnel frame error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    socket.on("close", (code, reason) => {
      ws = null;
      if (stopped) return;
      const why = reason?.toString?.() || "";
      console.error(
        `ChimpHands agent tunnel WS closed; code=${code} reason=${why || "(none)"} reconnecting in ${backoffMs}ms`,
      );
      reconnectTimer = setTimeout(() => {
        void connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    });

    socket.on("error", (err) => {
      console.error(
        `ChimpHands agent tunnel WS error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  void connect();
  return () => {
    stopped = true;
    clearReconnect();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}

/** Runtime-aware entry: register + attach to local OpenCode server (Phase 1+). */
export async function serveChimphands(opts: RunOptions & { attachUrl: string }): Promise<void> {
  const attachUrl = opts.attachUrl.trim();
  if (!attachUrl) {
    throw new Error("--attach URL is required for chimphands serve");
  }
  // Wait for OpenCode server readiness.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(attachUrl.replace(/\/$/, "") + "/");
      if (res.ok || res.status === 401 || res.status === 404) break;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  await runChimphands({ ...opts, attachUrl });
}
