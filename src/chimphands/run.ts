/**
 * ChimpHands GitHub Actions bridge: bootstrap → OpenCode → inbound SSE turns.
 * Relies on TESTCHIMP_API_KEY (+ optional TESTCHIMP_BACKEND_URL; defaults to prod).
 * Does not write mcp.json — TestChimp MCP is wired via opencode.json for OpenCode.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { getBackendUrl, requireApiKey } from "../core/client.js";
import { isChimphandsLlmRetryEnabled, startLlmRetryProxy } from "./llmRetryProxy.js";

const ROLE_ASSISTANT = "CHIMPHANDS_MESSAGE_ROLE_ASSISTANT";
const ROLE_TOOL = "CHIMPHANDS_MESSAGE_ROLE_TOOL";
const ROLE_REASONING = "CHIMPHANDS_MESSAGE_ROLE_REASONING";
const ROLE_STATUS = "CHIMPHANDS_MESSAGE_ROLE_STATUS";

const STATUS_RUNNING = "CHIMPHANDS_SESSION_STATUS_RUNNING";
const STATUS_WAITING_USER = "CHIMPHANDS_SESSION_STATUS_WAITING_USER";
const STATUS_IDLE = "CHIMPHANDS_SESSION_STATUS_IDLE";
const STATUS_FAILED = "CHIMPHANDS_SESSION_STATUS_FAILED";

const OPENCODE_AGENT_ID = "chimphands";
/** Coalesce live token fanout (~6–10 posts/s/session) while UI is attached. */
const STREAM_POST_MIN_INTERVAL_MS = 150;

function isStreamFanoutRole(role: string): boolean {
  return role === ROLE_ASSISTANT || role === ROLE_TOOL || role === ROLE_REASONING;
}

/**
 * OpenCode sometimes emits the same thought as both a reasoning part and a text part.
 * Skip ASSISTANT fanout when content matches (or is a streaming prefix of) reasoning.
 */
function isTextDuplicateOfReasoning(text: string, reasoningBodies: Iterable<string>): boolean {
  const a = String(text || "").trim();
  if (!a) return false;
  for (const raw of reasoningBodies) {
    const r = String(raw || "").trim();
    if (!r) continue;
    if (a === r) return true;
    if (a.length >= 32 && r.length >= 32 && (r.startsWith(a) || a.startsWith(r))) {
      return true;
    }
  }
  return false;
}

function reasoningBodiesFromPartMap(textByPartId: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, val] of textByPartId) {
    if (key.startsWith("reasoning:")) out.push(val);
  }
  return out;
}

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
- Commit and push on the session working branch after meaningful edit batches. When \`CHIMPHANDS_UI_ATTACHED\` is \`false\` (no browser watching live), **commit and push before ending every turn** so the user can review async via PR / Files changed. The host also commits any remaining dirty worktree after each turn and before idle teardown.
- Branch names MUST start with \`testchimp-\` or \`chimphands-\`.
- When creating a NEW working branch: create it, then IMMEDIATELY publish it with
  \`git push -u origin <branch>\` BEFORE calling report-branch. Users open the branch URL in the UI —
  do not report a branch that only exists locally (that causes GitHub 404).
- After the branch is on the remote (and after opening a PR), IMMEDIATELY run:
  \`testchimp chimphands report-branch --branch <name> [--pr-url <url>]\`
- Tell the user which branch you are on and include the PR URL when available.
- **GitHub auth expiry (self-fix):** Job-start App installation tokens expire after ~1 hour. On \`git push\` / \`gh\` auth failures (401/403 / Authentication failed / write access not granted), run \`testchimp chimphands refresh-git-auth\` then retry — **never** ask the user to paste or reconnect a GitHub token in chat. See skill \`references/chimphands-faq.md\`.

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
  ui_attached?: boolean;
  uiAttached?: boolean;
  pending_user_messages?: Array<{ id?: string; message_id?: string; content?: string }>;
  pendingUserMessages?: Array<{ id?: string; messageId?: string; content?: string }>;
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
  /** Structured tool lifecycle for live UI countdown (not persisted to PG). */
  toolExecution?: ChimpHandsToolExecutionPayload;
  /** When true, coalesce rapid assistant/reasoning chunks. */
  throttle?: boolean;
  /**
   * Live OpenCode /event deltas. Dropped when UI is detached.
   * Never persisted — turn-end reconcile writes PG.
   */
  liveStream?: boolean;
  /**
   * Turn-end / completed transcript. Always `post_agent_event`; never ephemeral.
   */
  durable?: boolean;
};

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "TestChimp-Api-Key": apiKey,
  };
}

const POST_JSON_TIMEOUT_MS = 30_000;

async function postJson(backend: string, apiKey: string, path: string, body: unknown): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POST_JSON_TIMEOUT_MS);
  try {
    const res = await fetch(`${backend}${path}`, {
      method: "POST",
      headers: apiHeaders(apiKey),
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ChimpHands API ${res.status} ${path}: ${text}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Serializes agent event posts so streaming chunks fan out in order. */
class AgentEventPoster {
  private chain: Promise<void> = Promise.resolve();
  private lastStreamPostAt = 0;
  /** When false, liveStream tokens are dropped; completed events still persist. */
  uiAttached = false;
  private ephemeralFailLogAt = 0;
  private ephemeralFailCount = 0;

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
    if (opts?.toolExecution) body.toolExecution = opts.toolExecution;

    const streamRole = isStreamFanoutRole(role);

    this.chain = this.chain.then(async () => {
      const live = !!opts?.liveStream && !opts?.durable;
      // Mid-turn tokens never hit PG. Async / detached: drop. Attached: ephemeral only.
      if (live && !this.uiAttached) {
        return;
      }

      if (opts?.throttle || (streamRole && live)) {
        const now = Date.now();
        const wait = STREAM_POST_MIN_INTERVAL_MS - (now - this.lastStreamPostAt);
        if (wait > 0) await sleep(wait);
        this.lastStreamPostAt = Date.now();
      }

      const tryEphemeral = live && streamRole && this.uiAttached;
      if (tryEphemeral) {
        const eph: Record<string, unknown> = {
          sessionId: this.sessionId,
          role,
          content: body.content,
        };
        if (opts?.messageId) eph.messageId = opts.messageId;
        if (opts?.opencodeSessionId) eph.opencodeSessionId = opts.opencodeSessionId;
        if (opts?.toolExecution) eph.toolExecution = opts.toolExecution;
        try {
          await postJson(
            this.backend,
            this.apiKey,
            "/api/chimphands/post_ephemeral_agent_event",
            eph,
          );
          this.ephemeralFailCount = 0;
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          this.logEphemeralIssue(`ephemeral post failed — not persisting liveStream: ${detail}`);
        }
        return;
      }

      await postJson(this.backend, this.apiKey, "/api/chimphands/post_agent_event", body);
    });
    return this.chain;
  }

  /** Avoid flooding GHA logs when ephemeral 500s every ~150ms. */
  private logEphemeralIssue(message: string): void {
    this.ephemeralFailCount += 1;
    const now = Date.now();
    if (this.ephemeralFailCount <= 2 || now - this.ephemeralFailLogAt >= 10_000) {
      this.ephemeralFailLogAt = now;
      const suffix =
        this.ephemeralFailCount > 2 ? ` (x${this.ephemeralFailCount} since last log)` : "";
      console.error(`ChimpHands ${message}${suffix}`);
    }
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
    error?: string;
    input?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
};

type ChimpHandsToolExecutionPayload = {
  status: string;
  toolName?: string;
  startedAtMillis?: number;
  timeoutMillis?: number;
  endedAtMillis?: number;
};

const TOOL_STATUS_RUNNING = "CHIMPHANDS_TOOL_EXECUTION_STATUS_RUNNING";
const TOOL_STATUS_PENDING = "CHIMPHANDS_TOOL_EXECUTION_STATUS_PENDING";
const TOOL_STATUS_COMPLETED = "CHIMPHANDS_TOOL_EXECUTION_STATUS_COMPLETED";
const TOOL_STATUS_ERROR = "CHIMPHANDS_TOOL_EXECUTION_STATUS_ERROR";

function normalizeEpochMillis(raw?: number): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined;
  // OpenCode uses epoch millis; guard seconds.
  return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
}

function coerceTimeoutMillis(input?: Record<string, unknown>): number | undefined {
  if (!input) return undefined;
  const raw = input.timeout ?? input.timeoutMs ?? input.timeout_ms;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function mapToolExecutionStatus(status?: string): string | undefined {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return undefined;
  if (s === "pending") return TOOL_STATUS_PENDING;
  if (s === "running") return TOOL_STATUS_RUNNING;
  if (s === "completed") return TOOL_STATUS_COMPLETED;
  if (s === "error" || s === "failed" || s === "cancelled") return TOOL_STATUS_ERROR;
  return undefined;
}

/** First observed start time per OpenCode tool part — progress updates must not reset the UI countdown. */
const toolStartedAtByPartId = new Map<string, number>();

function toolExecutionFromOpencodePart(part: OpencodePart): ChimpHandsToolExecutionPayload | undefined {
  const status = mapToolExecutionStatus(part.state?.status);
  if (!status) return undefined;
  const partKey = String(part.id || part.messageID || "").trim();
  const fromOpencode = normalizeEpochMillis(part.state?.time?.start);
  const cached = partKey ? toolStartedAtByPartId.get(partKey) : undefined;
  const isActive =
    status === TOOL_STATUS_PENDING || status === TOOL_STATUS_RUNNING;
  let startedAtMillis = cached ?? fromOpencode;
  if (startedAtMillis == null && isActive) {
    startedAtMillis = Date.now();
  }
  if (partKey) {
    if (isActive && startedAtMillis != null) {
      toolStartedAtByPartId.set(partKey, startedAtMillis);
    } else if (
      status === TOOL_STATUS_COMPLETED ||
      status === TOOL_STATUS_ERROR
    ) {
      toolStartedAtByPartId.delete(partKey);
    }
  }
  const endedAtMillis = normalizeEpochMillis(part.state?.time?.end);
  const toolName = String(part.state?.title || part.tool || "").trim() || undefined;
  const timeoutMillis = coerceTimeoutMillis(part.state?.input);
  return {
    status,
    toolName,
    startedAtMillis,
    timeoutMillis,
    endedAtMillis,
  };
}

function toolEventOptions(
  part: OpencodePart,
  extra?: PostEventOptions,
): PostEventOptions {
  const toolExecution = toolExecutionFromOpencodePart(part);
  if (!toolExecution) return extra ?? {};
  return { ...extra, toolExecution };
}

type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  part?: OpencodePart;
  error?: { name?: string; message?: string; data?: { message?: string } };
};

/**
 * OpenCode `message.part.delta` always sends `field: "text"` for both reasoning and
 * answer parts. Resolve kind from partID → type learned via `message.part.updated`.
 */
function resolveDeltaPartKind(
  partId: string,
  field: string | undefined,
  partType: string | undefined,
  partTypeById: Map<string, string>,
): "text" | "reasoning" | "other" {
  if (partType) {
    partTypeById.set(partId, partType);
  }
  const known = partTypeById.get(partId);
  if (known === "reasoning" || partType === "reasoning") {
    partTypeById.set(partId, "reasoning");
    return "reasoning";
  }
  if (known === "text" || partType === "text") {
    partTypeById.set(partId, "text");
    return "text";
  }
  // Unknown part: field is unreliable (reasoning deltas also use field "text").
  if (field === "reasoning") {
    partTypeById.set(partId, "reasoning");
    return "reasoning";
  }
  return "text";
}

function parseOpencodeEvent(line: string): OpencodeEvent | null {
  try {
    return JSON.parse(line) as OpencodeEvent;
  } catch {
    return null;
  }
}

/**
 * Newer OpenCode `--format json` lines often use the SSE bus shape
 * (`message.part.updated` + `properties.part`) instead of legacy `type: "text"`.
 * Normalize both into the same OpencodeEvent used by the stdout switch.
 *
 * `partTypeById` must be shared across lines: deltas use `field: "text"` for
 * reasoning parts too — type comes from earlier `message.part.updated`.
 */
function normalizeStdoutOpencodeEvent(
  raw: unknown,
  partTypeById: Map<string, string>,
): OpencodeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Global envelope
  const inner =
    o.payload && typeof o.payload === "object"
      ? (o.payload as Record<string, unknown>)
      : o.event && typeof o.event === "object"
        ? (o.event as Record<string, unknown>)
        : o;

  const type = String(inner.type || "");
  const props = (inner.properties && typeof inner.properties === "object"
    ? (inner.properties as Record<string, unknown>)
    : {}) as {
    sessionID?: string;
    part?: OpencodePart & { sessionID?: string; type?: string };
    delta?: string;
    error?: OpencodeEvent["error"];
  };

  if (type === "message.part.delta") {
    // OpenCode streams tokens as { partID, field, delta } with no `part`.
    const deltaProps = props as {
      partID?: string;
      field?: string;
      delta?: string;
      sessionID?: string;
      part?: OpencodePart & { sessionID?: string; type?: string };
    };
    const part = deltaProps.part;
    if (part) {
      const partId = part.id || part.messageID || deltaProps.partID || "";
      const kind = partId
        ? resolveDeltaPartKind(partId, deltaProps.field, part.type, partTypeById)
        : part.type === "reasoning"
          ? "reasoning"
          : "text";
      let mapped: string | undefined;
      if (kind === "text" || part.type === "text") mapped = "text";
      else if (kind === "reasoning" || part.type === "reasoning") mapped = "reasoning";
      else if (part.type === "tool") mapped = "tool_use";
      else return null;
      if (deltaProps.delta && !part.text) part.text = deltaProps.delta;
      if (mapped === "reasoning") part.type = "reasoning";
      return {
        type: mapped,
        sessionID: part.sessionID || deltaProps.sessionID,
        part,
      };
    }
    const partID = deltaProps.partID;
    const delta = deltaProps.delta;
    if (!partID || delta == null || delta === "") return null;
    if (deltaProps.field && deltaProps.field !== "text" && deltaProps.field !== "reasoning") {
      return null;
    }
    const kind = resolveDeltaPartKind(partID, deltaProps.field, undefined, partTypeById);
    if (kind !== "text" && kind !== "reasoning") return null;
    return {
      type: kind,
      sessionID: deltaProps.sessionID,
      part: { id: partID, type: kind, text: delta },
    };
  }

  if (type === "message.part.updated") {
    const part = props.part;
    if (!part) return null;
    const partId = part.id || part.messageID;
    if (partId && part.type) {
      partTypeById.set(partId, part.type);
    }
    const partType = part.type || "";
    let mapped: string | undefined;
    if (partType === "text") mapped = "text";
    else if (partType === "reasoning") mapped = "reasoning";
    else if (partType === "tool") mapped = "tool_use";
    else return null;
    if (props.delta && !part.text) {
      part.text = props.delta;
    }
    return {
      type: mapped,
      sessionID: part.sessionID || props.sessionID,
      part,
    };
  }

  if (type === "session.error") {
    return {
      type: "error",
      sessionID: props.sessionID,
      error: props.error,
    };
  }

  // Legacy flat shape: { type: "text"|"tool_use"|..., part, sessionID }
  if (type) {
    return inner as OpencodeEvent;
  }
  return null;
}

/** Pull assistant/tool parts from OpenCode HTTP for durable PG (turn-end). */
async function reconcileOpencodeSessionMessages(
  attachUrl: string,
  opencodeSessionId: string,
  postEvent: RunOpencodeCallbacks["postEvent"],
  onWorkingBranch?: RunOpencodeCallbacks["onWorkingBranch"],
): Promise<number> {
  const base = attachUrl.replace(/\/$/, "");
  const url = `${base}/session/${encodeURIComponent(opencodeSessionId)}/message`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "x-opencode-directory": process.cwd() },
    });
  } catch (err: unknown) {
    console.error(
      `ChimpHands reconcile messages fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
  if (!res.ok) {
    console.error(`ChimpHands reconcile messages HTTP ${res.status}`);
    return 0;
  }
  const data = (await res.json()) as Array<{
    info?: { id?: string; role?: string };
    parts?: Array<OpencodePart & { type?: string; id?: string; text?: string; tool?: string }>;
  }>;
  if (!Array.isArray(data)) return 0;

  // Only parts after the latest user message (this turn). Full-history reconcile
  // every turn would O(n) upsert the entire transcript for no benefit.
  let lastUserIdx = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    if ((data[i]?.info?.role || "").toLowerCase() === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const turnSlice = lastUserIdx >= 0 ? data.slice(lastUserIdx + 1) : data;

  let posted = 0;
  for (const msg of turnSlice) {
    if ((msg.info?.role || "").toLowerCase() !== "assistant") continue;
    const reasoningBodies = (msg.parts || [])
      .filter((p) => p.type === "reasoning" && p.text?.trim())
      .map((p) => p.text!.trim());
    for (const part of msg.parts || []) {
      if (part.type === "text" && part.text?.trim()) {
        const text = part.text.trim();
        if (isTextDuplicateOfReasoning(text, reasoningBodies)) {
          continue;
        }
        postEvent(ROLE_ASSISTANT, text, {
          messageId: opencodeMessageId("oc_text_", part),
        });
        posted += 1;
      } else if (part.type === "reasoning" && part.text?.trim()) {
        postEvent(ROLE_REASONING, part.text.trim(), {
          messageId: opencodeMessageId("oc_reasoning_", part),
        });
        posted += 1;
      } else if (part.type === "tool") {
        const status = part.state?.status;
        if (!status || status === "pending" || status === "running") continue;
        const toolContent = formatToolUseContent(part);
        postEvent(ROLE_TOOL, toolContent, toolEventOptions(part, {
          messageId: opencodeMessageId("oc_tool_", part),
        }));
        posted += 1;
        if (status === "completed") {
          const detected = detectWorkingBranchFromToolOutput(toolContent);
          if (detected.branch) onWorkingBranch?.(detected.branch, detected.pullRequestUrl);
        }
      }
    }
  }
  if (posted) {
    console.error(`ChimpHands reconciled ${posted} part(s) from OpenCode session API (this turn)`);
  }
  return posted;
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

/**
 * OpenCode `run --format json` only emits completed text (`part.time.end`).
 * Live tokens come from the server SSE bus (`message.part.updated` + optional `delta`).
 * Subscribe directly when attaching so the platform chat streams.
 */
function startOpencodeSseRelay(
  attachUrl: string,
  callbacks: {
    getActiveSessionId: () => string | undefined;
    noteSessionId: (sessionId?: string) => void;
    postEvent: RunOpencodeCallbacks["postEvent"];
    onWorkingBranch?: RunOpencodeCallbacks["onWorkingBranch"];
  },
): () => void {
  const base = attachUrl.replace(/\/$/, "");
  const ac = new AbortController();
  let stopped = false;
  const textByPartId = new Map<string, string>();
  /** partID → "text" | "reasoning" | … from message.part.updated (deltas lie about field). */
  const partTypeById = new Map<string, string>();
  const directory = process.cwd();

  const sessionMatches = (sessionId?: string): boolean => {
    const active = callbacks.getActiveSessionId();
    if (!sessionId) return !active;
    if (!active) return true;
    return sessionId === active;
  };

  const liveOpts = (extra?: PostEventOptions): PostEventOptions => ({
    ...extra,
    throttle: true,
    liveStream: true,
  });

  const unwrapBusPayload = (raw: unknown): unknown => {
    if (!raw || typeof raw !== "object") return raw;
    const o = raw as Record<string, unknown>;
    // /global/event wraps as { directory, payload } or { directory, event }
    if (o.payload && typeof o.payload === "object") return o.payload;
    if (o.event && typeof o.event === "object") return o.event;
    return raw;
  };

  const handleBusEvent = (raw: unknown) => {
    const unwrapped = unwrapBusPayload(raw);
    if (!unwrapped || typeof unwrapped !== "object") return;
    const ev = unwrapped as {
      type?: string;
      properties?: {
        sessionID?: string;
        partID?: string;
        field?: string;
        part?: OpencodePart & { sessionID?: string; type?: string };
        delta?: string;
        error?: { name?: string; message?: string; data?: { message?: string } };
      };
    };
    const type = ev.type || "";
    const props = ev.properties || {};

    // Token stream: { partID, field, delta } — field is usually "text" even for reasoning.
    if (type === "message.part.delta") {
      const part = props.part;
      const partId = props.partID || part?.id || part?.messageID;
      const sessionId = part?.sessionID || props.sessionID;
      if (!sessionMatches(sessionId)) return;
      callbacks.noteSessionId(sessionId);
      if (!partId || props.delta == null || props.delta === "") return;

      const kind = resolveDeltaPartKind(partId, props.field, part?.type, partTypeById);
      if (kind === "reasoning") {
        const key = `reasoning:${partId}`;
        const next = (textByPartId.get(key) || "") + props.delta;
        textByPartId.set(key, next);
        callbacks.postEvent(ROLE_REASONING, next, liveOpts({
          messageId: `oc_reasoning_${partId}`,
        }));
        return;
      }
      if (kind === "text") {
        const next = (textByPartId.get(partId) || "") + props.delta;
        textByPartId.set(partId, next);
        if (isTextDuplicateOfReasoning(next, reasoningBodiesFromPartMap(textByPartId))) {
          return;
        }
        callbacks.postEvent(ROLE_ASSISTANT, next, liveOpts({
          messageId: `oc_text_${partId}`,
        }));
      }
      return;
    }

    if (type === "message.part.updated") {
      const part = props.part;
      if (!part) return;
      const sessionId = part.sessionID || props.sessionID;
      if (!sessionMatches(sessionId)) return;
      callbacks.noteSessionId(sessionId);

      const partId = part.id || part.messageID;
      if (partId && part.type) {
        partTypeById.set(partId, part.type);
      }

      if (part.type === "text") {
        if (!partId) return;
        let next = part.text || "";
        if (props.delta && !part.text) {
          next = (textByPartId.get(partId) || "") + props.delta;
        } else if (!next && props.delta === undefined) {
          return;
        }
        if (part.text) next = part.text;
        textByPartId.set(partId, next);
        if (!next) return;
        if (isTextDuplicateOfReasoning(next, reasoningBodiesFromPartMap(textByPartId))) {
          return;
        }
        callbacks.postEvent(ROLE_ASSISTANT, next, liveOpts({
          messageId: opencodeMessageId("oc_text_", part),
        }));
        return;
      }

      if (part.type === "reasoning") {
        if (!partId) return;
        // Deltas before type was known may have been buffered under the text key.
        const orphanText = textByPartId.get(partId);
        if (orphanText) {
          textByPartId.delete(partId);
        }
        let next = part.text || "";
        if (props.delta && !part.text) {
          next = (textByPartId.get(`reasoning:${partId}`) || orphanText || "") + props.delta;
        } else if (!next && orphanText) {
          next = orphanText;
        }
        if (part.text) next = part.text;
        textByPartId.set(`reasoning:${partId}`, next);
        if (!next) return;
        callbacks.postEvent(ROLE_REASONING, next, liveOpts({
          messageId: opencodeMessageId("oc_reasoning_", part),
        }));
        return;
      }

      if (part.type === "tool") {
        const status = part.state?.status;
        if (!status || status === "pending") return;
        // Ephemeral "(running)" bubbles while UI attached (liveStream gated in poster).
        if (status === "running") {
          const toolContent = formatToolUseContent(part);
          callbacks.postEvent(ROLE_TOOL, toolContent, toolEventOptions(part, liveOpts({
            messageId: opencodeMessageId("oc_tool_", part),
            throttle: false,
          })));
          return;
        }
        const toolContent = formatToolUseContent(part);
        callbacks.postEvent(ROLE_TOOL, toolContent, toolEventOptions(part, liveOpts({
          messageId: opencodeMessageId("oc_tool_", part),
          throttle: false,
        })));
        if (status === "completed") {
          const detected = detectWorkingBranchFromToolOutput(toolContent);
          if (detected.branch) {
            callbacks.onWorkingBranch?.(detected.branch, detected.pullRequestUrl);
          }
        }
      }
      return;
    }

    if (type === "session.error") {
      const sessionId = props.sessionID;
      if (!sessionMatches(sessionId)) return;
      const msg =
        props.error?.data?.message || props.error?.message || props.error?.name || "OpenCode session error";
      callbacks.postEvent(ROLE_STATUS, String(msg), { status: STATUS_RUNNING });
    }
  };

  const consume = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() || "";
      for (const chunk of chunks) {
        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          handleBusEvent(JSON.parse(data));
        } catch {
          /* ignore malformed */
        }
      }
    }
  };

  const candidates = (): string[] => {
    const dirQ = `directory=${encodeURIComponent(directory)}`;
    return [
      `/event?${dirQ}`,
      `/event`,
      `/global/event?${dirQ}`,
      `/global/event`,
    ];
  };

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      let connected = false;
      for (const path of candidates()) {
        if (stopped) return;
        try {
          const res = await fetch(`${base}${path}`, {
            headers: {
              Accept: "text/event-stream",
              "x-opencode-directory": directory,
            },
            signal: ac.signal,
          });
          if (!res.ok || !res.body) {
            console.error(`ChimpHands OpenCode SSE ${path} HTTP ${res.status}`);
            continue;
          }
          console.error(`ChimpHands OpenCode SSE streaming via ${path}`);
          connected = true;
          await consume(res.body);
          // Stream ended — retry if still attached.
          break;
        } catch (err: unknown) {
          if (stopped || ac.signal.aborted) return;
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`ChimpHands OpenCode SSE ${path} failed: ${detail}`);
        }
      }
      if (stopped || ac.signal.aborted) return;
      if (!connected && attempt === 0) {
        console.error(
          "ChimpHands OpenCode SSE not connected yet — using completed-only --format json until SSE connects (retrying)",
        );
      }
      attempt += 1;
      const backoff = Math.min(30_000, 2_000 * attempt);
      await sleep(backoff);
    }
  })();

  return () => {
    stopped = true;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  };
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

/** Strip one layer of wrapping quotes models sometimes add when echoing. */
function stripOuterQuotes(text: string): string {
  const a = String(text || "").trim();
  if (
    (a.startsWith('"') && a.endsWith('"')) ||
    (a.startsWith("'") && a.endsWith("'"))
  ) {
    return a.slice(1, -1).trim();
  }
  return a;
}

/**
 * True when assistant text is an echo of a prompt we just sent to OpenCode
 * (raw user text and/or host-wrapped effectivePrompt) — exact or streaming prefix.
 */
function isAssistantEchoOfSentPrompt(assistant: string, ...sentPrompts: string[]): boolean {
  const a = stripOuterQuotes(assistant);
  if (!a) return false;
  for (const raw of sentPrompts) {
    const p = String(raw || "").trim();
    if (!p) continue;
    if (a === p) return true;
    // Streaming echo from the start of the wrapped prompt.
    if (p.length >= 64 && a.length >= 24 && p.startsWith(a)) return true;
    // Mid-wrap regurgitation (e.g. only the "Conversation so far:" section).
    if (p.length >= 64 && a.length >= 40 && p.includes(a)) return true;
  }
  return false;
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
  // Do NOT inject "Interactive turn reminder" into the user prompt — it is already in
  // CHIMPHANDS_AGENT_PROMPT (system). Putting it here makes OpenCode store it as the
  // user message and the UI shows host control text in chat.
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
    /push\s+(?:--set-upstream\s+|-u\s+)?origin\s+((?:testchimp-|chimphands-)[^\s'"\[\]]+)/i
  );
  const branch = pushMatch?.[1]?.replace(/[`'"\[\]]/g, "");
  return {
    branch,
    pullRequestUrl: prMatch?.[0],
  };
}

function writeOpencodeConfig(
  backend: string,
  apiKey: string,
  boot: BootstrapResponse,
  llmBaseOverride?: string,
): string {
  const llmBase = (
    llmBaseOverride ||
    bootStr(boot, "llm_base_url", "llmBaseUrl") ||
    `${backend}/v1`
  ).replace(/\/$/, "");
  const llmKey = apiKey || bootStr(boot, "llm_api_key", "llmApiKey");
  const modelId = resolveOpencodeModelId(boot);
  const model = `${TESTCHIMP_PROVIDER_ID}/${modelId}`;
  const sessionId = bootStr(boot, "session_id", "sessionId");
  const uiAttached = !!(boot.uiAttached ?? boot.ui_attached);
  const mcpEnv: Record<string, string> = {
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
    TESTCHIMP_EXECUTION_SOURCE: "CLOUD_AGENT",
    CHIMPHANDS_UI_ATTACHED: uiAttached ? "true" : "false",
  };
  const serviceUserId = bootStr(boot, "chimphands_service_account_user_id", "chimphandsServiceAccountUserId");
  if (serviceUserId) {
    mcpEnv.TESTCHIMP_USER_ID = serviceUserId;
  }
  const providerOptions: Record<string, unknown> = {
    apiKey: llmKey,
    baseURL: llmBase,
    // Retry proxy may wait up to 5 min; allow long completions after upstream is healthy.
    timeout: 900_000,
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
              "*": "allow",
              skill: "allow",
              bash: "allow",
              edit: "allow",
              read: "allow",
              question: "allow",
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
            // Prefer the already-installed global binary — `npx -y @latest` can hang in GHA.
            command: ["testchimp", "mcp"],
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
  getCancelRequested?: () => boolean;
  onActiveChild?: (child: ChildProcess | null) => void;
};

/** Abort in-flight tool/LLM work on the local OpenCode server (attach mode). */
async function abortOpencodeSession(attachUrl: string, opencodeSessionId: string): Promise<void> {
  const base = attachUrl.replace(/\/$/, "");
  const url = `${base}/session/${encodeURIComponent(opencodeSessionId)}/abort`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-opencode-directory": process.cwd(),
      },
    });
    console.error(
      `ChimpHands OpenCode session abort: session=${opencodeSessionId} http=${res.status}`,
    );
  } catch (err: unknown) {
    console.error(
      `ChimpHands OpenCode session abort failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Deliver a user message into an active OpenCode turn without aborting it. */
async function injectOpencodeUserMessage(
  attachUrl: string,
  opencodeSessionId: string,
  content: string,
): Promise<boolean> {
  const base = attachUrl.replace(/\/$/, "");
  const url = `${base}/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-opencode-directory": process.cwd(),
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: content }],
      }),
    });
    if (res.status === 204 || res.ok) {
      const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content;
      console.error(
        `ChimpHands injected mid-turn user message into OpenCode session ${opencodeSessionId}: ${JSON.stringify(preview)}`,
      );
      return true;
    }
    console.error(
      `ChimpHands mid-turn inject HTTP ${res.status} for session ${opencodeSessionId}`,
    );
    return false;
  } catch (err: unknown) {
    console.error(
      `ChimpHands mid-turn inject failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function parseInboundUserMessage(data: unknown): InboundUserMessage | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  const content = typeof msg.content === "string" ? msg.content : "";
  const idRaw =
    (typeof msg.id === "string" && msg.id) ||
    (typeof msg.message_id === "string" && msg.message_id) ||
    (typeof msg.messageId === "string" && msg.messageId) ||
    "";
  return { id: idRaw || undefined, content };
}

function buildOpencodeArgs(
  prompt: string,
  model: string,
  opencodeSessionId?: string,
  attachUrl?: string,
): string[] {
  // --auto: headless CI must approve tool permissions (1.18+ otherwise auto-rejects).
  // --print-logs: surface server/client progress on stderr while waiting for first token.
  const args = [
    "run",
    prompt,
    "--model",
    model,
    "--format",
    "json",
    "--agent",
    OPENCODE_AGENT_ID,
    "--auto",
    "--print-logs",
  ];
  if (opencodeSessionId?.trim()) {
    args.push("--session", opencodeSessionId.trim());
  }
  if (attachUrl?.trim()) {
    args.push("--attach", attachUrl.trim());
  }
  return args;
}

function killListenersOnPort(port: string): void {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      const n = Number(pid);
      if (!Number.isFinite(n) || n <= 0) continue;
      try {
        process.kill(n, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

async function waitForOpencodeHttp(attachUrl: string, timeoutMs: number): Promise<void> {
  const base = attachUrl.replace(/\/$/, "");
  const deadline = Date.now() + timeoutMs;
  const perTryMs = 2_000;
  let attempt = 0;
  let lastErr = "";
  while (Date.now() < deadline) {
    attempt += 1;
    for (const path of ["/global/health", "/"]) {
      try {
        const res = await fetch(`${base}${path}`, {
          signal: AbortSignal.timeout(perTryMs),
        });
        if (res.ok || res.status === 401 || res.status === 404) {
          console.error(
            `ChimpHands OpenCode HTTP ready at ${attachUrl}${path} (http ${res.status}, attempt ${attempt})`,
          );
          return;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (err: unknown) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (attempt === 1 || attempt % 5 === 0) {
      const left = Math.max(0, deadline - Date.now());
      console.error(
        `ChimpHands waiting for OpenCode HTTP at ${attachUrl} (attempt ${attempt}, ${Math.ceil(left / 1000)}s left): ${lastErr || "not ready"}`,
      );
    }
    await sleep(400);
  }
  throw new Error(
    `OpenCode server not ready at ${attachUrl} within ${timeoutMs}ms` +
      (lastErr ? ` (last: ${lastErr})` : ""),
  );
}

/**
 * Restart local `opencode serve` after writing opencode.json so the server loads
 * TestChimp provider + default_agent. Workflow may have started serve earlier without config.
 */
async function restartLocalOpencodeServer(attachUrl: string): Promise<void> {
  const u = new URL(attachUrl);
  const hostname = u.hostname || "127.0.0.1";
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  killListenersOnPort(port);
  await sleep(300);

  const logFd = openSync("opencode-server.log", "a");
  const child = spawn(
    "opencode",
    ["serve", "--port", port, "--hostname", hostname],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
  if (child.pid) {
    try {
      writeFileSync("/tmp/opencode-server.pid", String(child.pid));
    } catch {
      /* best effort */
    }
  }
  console.error(`ChimpHands restarted OpenCode serve on ${hostname}:${port} (pid ${child.pid ?? "?"})`);
  await waitForOpencodeHttp(attachUrl, 60_000);
}

function runOpencode(
  prompt: string,
  model: string,
  childEnv: NodeJS.ProcessEnv,
  opencodeSessionId: string | undefined,
  callbacks: RunOpencodeCallbacks,
  attachUrl?: string,
): Promise<{ code: number; err: string; opencodeSessionId?: string; cancelled?: boolean }> {
  let activeSessionId = opencodeSessionId?.trim() || undefined;
  const baseArgs = buildOpencodeArgs(prompt, model, activeSessionId, attachUrl);
  const preview = prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt;
  console.error(
    `ChimpHands invoking OpenCode: model=${model} attach=${attachUrl || "(local)"} session=${activeSessionId || "(new)"} prompt=${JSON.stringify(preview)}`,
  );

  // pipe+end stdin so OpenCode does not wait on Bun.stdin.text() (non-TTY).
  const child = spawn("opencode", baseArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  callbacks.onActiveChild?.(child);
  try {
    child.stdin?.end();
  } catch {
    /* ignore */
  }
  let err = "";
  child.stderr.on("data", (d: Buffer) => {
    const chunk = d.toString();
    err += chunk;
    // Live-forward so GHA shows progress while waiting for first JSON event.
    process.stderr.write(chunk);
  });

  return new Promise((resolve) => {
    let buf = "";
    let fatalError: string | null = null;
    const textByPartId = new Map<string, string>();
    const partTypeById = new Map<string, string>();
    let sawStdout = false;
    let cancelEscalationTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelWatcher: ReturnType<typeof setInterval> | null = null;
    const clearCancelWatcher = () => {
      if (cancelWatcher) {
        clearInterval(cancelWatcher);
        cancelWatcher = null;
      }
      if (cancelEscalationTimer) {
        clearTimeout(cancelEscalationTimer);
        cancelEscalationTimer = null;
      }
    };
    const killActiveChild = (signal: NodeJS.Signals) => {
      try {
        if (!child.killed) child.kill(signal);
      } catch {
        /* ignore */
      }
    };
    cancelWatcher = setInterval(() => {
      if (!callbacks.getCancelRequested?.()) return;
      clearCancelWatcher();
      killActiveChild("SIGTERM");
      cancelEscalationTimer = setTimeout(() => killActiveChild("SIGKILL"), 2000);
    }, 500);
    let progressTicker: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (sawStdout) {
        if (progressTicker) {
          clearInterval(progressTicker);
          progressTicker = null;
        }
        return;
      }
      callbacks.postEvent(ROLE_STATUS, "Agent is still working… (waiting for OpenCode output)", {
        status: STATUS_RUNNING,
      });
    }, 15_000);

    const noteSessionId = (sessionId?: string) => {
      const id = sessionId?.trim();
      if (!id || id === activeSessionId) return;
      activeSessionId = id;
      callbacks.onSessionId?.(id);
    };

    const handleOpencodeLine = (line: string) => {
      if (!line.trim()) return;
      if (!sawStdout) {
        sawStdout = true;
        console.error("ChimpHands OpenCode first stdout event received");
        if (progressTicker) {
          clearInterval(progressTicker);
          progressTicker = null;
        }
      }
      const fatal = extractOpencodeFatalError(line);
      if (fatal) {
        fatalError = fatal;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      // Newer OpenCode --format json uses bus shape (message.part.updated); normalize first.
      const ev = normalizeStdoutOpencodeEvent(parsed, partTypeById) || parseOpencodeEvent(line);
      if (!ev?.type) return;
      noteSessionId(ev.sessionID);

      switch (ev.type) {
        case "text":
        case "reasoning":
        case "tool_use": {
          // Attach mode: live tokens come from OpenCode SSE; durable from turn-end
          // reconcile. Avoid double-fanout / double-accumulation with stdout.
          if (attachUrl) return;
          break;
        }
        default:
          break;
      }

      switch (ev.type) {
        case "text": {
          const chunk = ev.part?.text;
          if (!chunk) return;
          const partId = ev.part?.id || ev.part?.messageID;
          if (!partId) {
            if (!isTextDuplicateOfReasoning(chunk, reasoningBodiesFromPartMap(textByPartId))) {
              callbacks.postEvent(ROLE_ASSISTANT, chunk, { throttle: true });
            }
            return;
          }
          // Without attach, --format json may emit completed cumulative or deltas.
          // Prefer replace when we already have longer text (cumulative); else append.
          const prev = textByPartId.get(partId) || "";
          const next = !prev
            ? chunk
            : chunk.startsWith(prev)
              ? chunk
              : prev + chunk;
          textByPartId.set(partId, next);
          if (isTextDuplicateOfReasoning(next, reasoningBodiesFromPartMap(textByPartId))) {
            return;
          }
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
          const prev = textByPartId.get(reasoningKey) || "";
          const next = !prev
            ? chunk
            : chunk.startsWith(prev)
              ? chunk
              : prev + chunk;
          textByPartId.set(reasoningKey, next);
          callbacks.postEvent(ROLE_REASONING, next, {
            throttle: true,
            messageId: opencodeMessageId("oc_reasoning_", ev.part),
          });
          return;
        }
        case "tool_use": {
          // Durable-only path (no attach). Skip in-progress.
          const status = ev.part?.state?.status;
          if (!status || status === "pending" || status === "running") return;
          const toolContent = formatToolUseContent(ev.part!);
          callbacks.postEvent(ROLE_TOOL, toolContent, toolEventOptions(ev.part!, {
            messageId: opencodeMessageId("oc_tool_", ev.part),
          }));
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
      callbacks.onActiveChild?.(null);
      clearCancelWatcher();
      if (progressTicker) {
        clearInterval(progressTicker);
        progressTicker = null;
      }
      if (buf.trim()) {
        handleOpencodeLine(buf.trim());
      }
      const stderrFatal = extractOpencodeFatalError(err);
      if (stderrFatal) fatalError = stderrFatal;
      if (callbacks.getCancelRequested?.()) {
        resolve({ code: 0, err: "", opencodeSessionId: activeSessionId, cancelled: true });
        return;
      }
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

function normalizeWorktreeRelativePath(filePath: string): string {
  let p = String(filePath || "").trim().replace(/\\/g, "/");
  while (p.startsWith("/")) p = p.slice(1);
  if (!p || p.includes("\0")) {
    throw new Error("invalid path");
  }
  const segments: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.length) throw new Error("invalid path");
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (!segments.length) throw new Error("invalid path");
  return segments.join("/");
}

async function ackWorktreeFileWrite(
  backend: string,
  apiKey: string,
  sessionId: string,
  requestId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    sessionId,
    requestId,
    ok,
  };
  if (errorMessage) body.errorMessage = errorMessage.slice(0, 2000);
  await postJson(backend, apiKey, "/api/chimphands/ack_worktree_file_write", body).catch(
    (err: unknown) => {
      console.error(
        `ChimpHands ack_worktree_file_write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}

async function applyUserFileEdit(
  backend: string,
  apiKey: string,
  sessionId: string,
  edit: { requestId: string; path: string; content: string },
  turnActive: () => boolean,
): Promise<void> {
  if (turnActive()) {
    await ackWorktreeFileWrite(backend, apiKey, sessionId, edit.requestId, false, "agent turn in progress");
    return;
  }
  try {
    const relative = normalizeWorktreeRelativePath(edit.path);
    const root = process.cwd();
    const full = path.resolve(root, relative);
    const rootResolved = path.resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      throw new Error("path outside worktree");
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, edit.content, "utf8");
    await ackWorktreeFileWrite(backend, apiKey, sessionId, edit.requestId, true);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await ackWorktreeFileWrite(backend, apiKey, sessionId, edit.requestId, false, msg);
  }
}

function connectInboundStream(
  backend: string,
  apiKey: string,
  sessionId: string,
  handlers: {
    onUserMessage: (msg: InboundUserMessage) => void;
    onIdle: () => void;
    onCancelTurn?: () => void;
    onUserFileEdit?: (edit: { requestId: string; path: string; content: string }) => void;
    shouldRun: () => boolean;
  },
): () => void {
  const url = new URL(`${backend}/api/chimphands/sessions/${encodeURIComponent(sessionId)}/inbound`);
  const lib = url.protocol === "https:" ? https : http;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;
  let activeReq: http.ClientRequest | null = null;

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
    if (activeReq) {
      try {
        activeReq.destroy();
      } catch {
        /* ignore */
      }
      activeReq = null;
    }
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
              } else if (eventName === "cancel_turn") {
                try {
                  const payload = JSON.parse(data) as { sessionId?: string };
                  if (payload.sessionId && payload.sessionId !== sessionId) {
                    continue;
                  }
                } catch {
                  /* ignore malformed payload */
                }
                console.error(`ChimpHands inbound SSE cancel_turn for session ${sessionId}`);
                handlers.onCancelTurn?.();
              } else if (eventName === "user_file_edit") {
                try {
                  const edit = JSON.parse(data) as {
                    sessionId?: string;
                    requestId?: string;
                    request_id?: string;
                    path?: string;
                    content?: string;
                  };
                  if (edit.sessionId && edit.sessionId !== sessionId) {
                    continue;
                  }
                  const requestId = edit.requestId || edit.request_id;
                  if (requestId && edit.path) {
                    handlers.onUserFileEdit?.({
                      requestId,
                      path: edit.path,
                      content: edit.content ?? "",
                    });
                  }
                } catch {
                  /* ignore */
                }
              } else if (eventName === "user_message" || eventName === "message") {
                try {
                  const msg = parseInboundUserMessage(JSON.parse(data));
                  if (!msg) continue;
                  console.error(`ChimpHands inbound SSE user_message for session ${sessionId}`);
                  handlers.onUserMessage(msg);
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
        res.on("end", () => {
          if (activeReq === req) activeReq = null;
          scheduleReconnect();
        });
      },
    );
    activeReq = req;
    req.on("error", () => {
      if (activeReq === req) activeReq = null;
      scheduleReconnect();
    });
    req.end();
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (activeReq) {
      try {
        activeReq.destroy();
      } catch {
        /* ignore */
      }
      activeReq = null;
    }
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
  poster.uiAttached = !!(boot.uiAttached ?? boot.ui_attached);
  process.env.CHIMPHANDS_UI_ATTACHED = poster.uiAttached ? "true" : "false";

  let stopLiveSse: (() => void) | null = null;
  /** Do not open localhost OpenCode /event until serve has been (re)started with config. */
  let opencodeHttpReady = !attachUrl;
  let pendingUiAttached = !!(boot.uiAttached ?? boot.ui_attached);
  /** Consecutive uiAttached=false heartbeats before stopping OpenCode SSE (multi-replica poison). */
  let consecutiveUiDetached = 0;
  const UI_DETACHED_STOP_AFTER = 3;
  const startLiveSseIfNeeded = (reason: string) => {
    if (!attachUrl || !opencodeHttpReady || stopLiveSse) return;
    console.error(`ChimpHands ${reason}`);
    stopLiveSse = startOpencodeSseRelay(attachUrl, {
      getActiveSessionId: () => opencodeSessionId,
      noteSessionId: (id) => {
        if (id?.trim()) opencodeSessionId = id.trim();
      },
      postEvent: (role, content, opts) => {
        poster.fireAndForget(role, content, {
          ...opts,
          opencodeSessionId: opts?.opencodeSessionId || opencodeSessionId,
        });
      },
      onWorkingBranch: noteWorkingBranchPlaceholder,
    });
  };
  const syncLiveSse = (attached: boolean) => {
    pendingUiAttached = attached;
    process.env.CHIMPHANDS_UI_ATTACHED = attached ? "true" : "false";
    if (!attachUrl) {
      poster.uiAttached = attached;
      return;
    }
    if (!opencodeHttpReady) {
      // Defer SSE; still track intent so first sync after ready is correct.
      poster.uiAttached = attached;
      if (attached) {
        console.error("ChimpHands UI attached — deferring OpenCode SSE until serve is ready");
      }
      return;
    }
    if (attached) {
      consecutiveUiDetached = 0;
      // Allow liveStream immediately when heartbeat says attached.
      poster.uiAttached = true;
      startLiveSseIfNeeded("UI attached — starting OpenCode SSE fanout");
      return;
    }
    // Detached / async: hysteresis avoids flap from cross-replica heartbeats.
    // Keep poster.uiAttached true + SSE up during the window so we don't drop
    // live tokens while the UI is still actually listening on another replica.
    consecutiveUiDetached += 1;
    if (consecutiveUiDetached < UI_DETACHED_STOP_AFTER) return;
    poster.uiAttached = false;
    if (stopLiveSse) {
      console.error(
        `ChimpHands UI detached for ${consecutiveUiDetached} heartbeats — stopping OpenCode SSE fanout`,
      );
      stopLiveSse();
      stopLiveSse = null;
    }
  };
  // noteWorkingBranch is defined later; bind via mutable holder until then.
  let noteWorkingBranch: (branch: string, prUrl?: string) => void = () => {};
  const noteWorkingBranchPlaceholder = (branch: string, prUrl?: string) => {
    noteWorkingBranch(branch, prUrl);
  };

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
    ? startRuntimeHeartbeat(backend, apiKey, runtimeId, (attached) => {
        syncLiveSse(attached);
      })
    : () => {};
  let stopTunnel: () => void = () => {};

  const userId = bootStr(boot, "chimphands_service_account_user_id", "chimphandsServiceAccountUserId");
  if (userId) {
    process.env.TESTCHIMP_USER_ID = userId;
  }

  mkdirSync(".opencode", { recursive: true });
  const upstreamLlmBase = (
    bootStr(boot, "llm_base_url", "llmBaseUrl") || `${backend}/v1`
  ).replace(/\/$/, "");
  let llmBaseForOpencode = upstreamLlmBase;
  let stopLlmProxy: (() => Promise<void>) | null = null;
  if (isChimphandsLlmRetryEnabled()) {
    const proxy = await startLlmRetryProxy(upstreamLlmBase);
    llmBaseForOpencode = proxy.baseUrl;
    stopLlmProxy = proxy.stop;
    console.error(`ChimpHands LLM retry proxy: ${llmBaseForOpencode} -> ${upstreamLlmBase}`);
  }
  const opencodeModel = writeOpencodeConfig(backend, apiKey, boot, llmBaseForOpencode);
  console.error(`ChimpHands OpenCode model: ${opencodeModel}`);
  if (attachUrl) {
    console.error(`ChimpHands OpenCode attach: ${attachUrl}`);
    // Serve must load opencode.json (provider + default_agent). Workflow often starts
    // serve before this file exists; restart so attach mode can omit --agent safely.
    // Heartbeat may have already reported ui_attached — wait until after restart to open SSE.
    await restartLocalOpencodeServer(attachUrl);
    opencodeHttpReady = true;
    syncLiveSse(pendingUiAttached);
  }

  let opencodeSessionId = bootStr(boot, "opencode_session_id", "opencodeSessionId") || undefined;
  const conversationSummary = bootStr(boot, "conversation_summary", "conversationSummary");
  let workingBranch = bootStr(boot, "working_branch", "workingBranch") || undefined;
  let pullRequestUrl = bootStr(boot, "pull_request_url", "pullRequestUrl") || undefined;

  noteWorkingBranch = (branch: string, prUrl?: string) => {
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

  // Apply bootstrap ui_attached now that session id + branch hooks exist.
  syncLiveSse(poster.uiAttached);

  const idleMs = (bootNum(boot, "idle_timeout_seconds", "idleTimeoutSeconds") || 600) * 1000;
  const queue: string[] = [];
  const seenUserMessageIds = new Set<string>();
  let idle = false;
  let sessionActive = true;
  let lastUserActivity = Date.now();
  let exitCode: number | undefined;
  let cancelTurnRequested = false;
  let activeOpencodeChild: ChildProcess | null = null;
  let agentTurnInProgress = false;
  /** Mid-turn messages waiting for an OpenCode session id before prompt_async inject. */
  const pendingMidTurnInject: string[] = [];
  /** Wakes waitForNextPrompt when idle is signaled (SSE) or a user message arrives. */
  let wakeWaitForPrompt: (() => void) | null = null;
  const wakePromptWaiter = () => {
    const wake = wakeWaitForPrompt;
    wakeWaitForPrompt = null;
    wake?.();
  };

  const turnControl = {
    getCancelRequested: () => cancelTurnRequested,
    onActiveChild: (child: ChildProcess | null) => {
      activeOpencodeChild = child;
    },
  };

  /** Abort in-flight OpenCode turn (session HTTP abort + kill `opencode run` child). */
  const abortActiveTurn = () => {
    cancelTurnRequested = true;
    const sessionToAbort = opencodeSessionId?.trim();
    if (attachUrl && sessionToAbort) {
      void abortOpencodeSession(attachUrl, sessionToAbort);
    }
    const ch = activeOpencodeChild;
    if (ch && !ch.killed) {
      try {
        ch.kill("SIGTERM");
        setTimeout(() => {
          try {
            if (!ch.killed) ch.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000);
      } catch {
        /* ignore */
      }
    }
  };

  const flushPendingMidTurnInject = () => {
    if (!attachUrl || !agentTurnInProgress) return;
    const sessionToInject = opencodeSessionId?.trim();
    if (!sessionToInject) return;
    while (pendingMidTurnInject.length) {
      const content = pendingMidTurnInject.shift()!;
      void injectOpencodeUserMessage(attachUrl, sessionToInject, content).then((ok) => {
        if (!ok) {
          queue.push(content);
          wakePromptWaiter();
        }
      });
    }
  };

  const enqueueUserMessage = (msg: InboundUserMessage) => {
    const id = msg.id?.trim();
    if (id) {
      if (seenUserMessageIds.has(id)) return;
      seenUserMessageIds.add(id);
    }
    const content = normalizeUserMessage(msg.content || "");
    if (!content) return;
    lastUserActivity = Date.now();
    idle = false;
    const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content;
    if (agentTurnInProgress && attachUrl) {
      const sessionToInject = opencodeSessionId?.trim();
      if (sessionToInject) {
        console.error(
          `ChimpHands delivering mid-turn user message via OpenCode prompt_async (turnActive=true): ${JSON.stringify(preview)}`,
        );
        void injectOpencodeUserMessage(attachUrl, sessionToInject, content).then((ok) => {
          if (!ok) {
            queue.push(content);
            wakePromptWaiter();
            return;
          }
          postEvent(ROLE_STATUS, "Message sent to agent…", { status: STATUS_RUNNING });
        });
        return;
      }
      pendingMidTurnInject.push(content);
      console.error(
        `ChimpHands holding mid-turn user message until OpenCode session id is available: ${JSON.stringify(preview)}`,
      );
      return;
    }
    queue.push(content);
    console.error(
      `ChimpHands queued user message (turnActive=${agentTurnInProgress}, depth=${queue.length}): ${JSON.stringify(preview)}`,
    );
    wakePromptWaiter();
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

  const seenWorktreeWriteRequestIds = new Set<string>();
  const handleUserFileEdit = (edit: { requestId: string; path: string; content: string }) => {
    if (seenWorktreeWriteRequestIds.has(edit.requestId)) return;
    seenWorktreeWriteRequestIds.add(edit.requestId);
    void applyUserFileEdit(backend, apiKey, sessionId, edit, () => agentTurnInProgress);
  };

  const postEvent = (role: string, content: string, opts?: PostEventOptions) => {
    const bodyOpts: PostEventOptions = { ...opts };
    if (opencodeSessionId && !bodyOpts.opencodeSessionId) {
      bodyOpts.opencodeSessionId = opencodeSessionId;
    }
    poster.fireAndForget(role, content, bodyOpts);
  };

  /**
   * Drop ASSISTANT bubbles that echo the prompt we just sent — either the raw
   * user text or the host-wrapped effectivePrompt (exact string OpenCode got).
   */
  const postEventForTurn = (
    userPrompt: string,
    wrappedPrompt: string,
    role: string,
    content: string,
    opts?: PostEventOptions,
  ) => {
    if (role === ROLE_ASSISTANT && isAssistantEchoOfSentPrompt(content, userPrompt, wrappedPrompt)) {
      return;
    }
    postEvent(role, content, opts);
  };

  const complete = async (status: string, errorMessage?: string) => {
    const body: Record<string, unknown> = { sessionId, status };
    if (errorMessage) body.errorMessage = String(errorMessage).slice(0, 4000);
    if (githubRunId) body.githubRunId = githubRunId;
    try {
      await postJson(backend, apiKey, "/api/chimphands/complete_session", body);
    } catch (err: unknown) {
      console.error(`ChimpHands complete_session failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TESTCHIMP_API_KEY: apiKey,
    TESTCHIMP_BACKEND_URL: backend,
    TESTCHIMP_EXECUTION_SOURCE: "CLOUD_AGENT",
  };
  if (userId) childEnv.TESTCHIMP_USER_ID = userId;

  const handleCancelTurn = () => {
    console.error(`ChimpHands cancel_turn received for session ${sessionId}`);
    abortActiveTurn();
  };

  const stopInbound = connectInboundStream(backend, apiKey, sessionId, {
    onUserMessage: enqueueUserMessage,
    onIdle: () => {
      idle = true;
      wakePromptWaiter();
    },
    onCancelTurn: handleCancelTurn,
    onUserFileEdit: handleUserFileEdit,
    shouldRun: () => sessionActive,
  });

  const inboundPollTimer = setInterval(() => {
    if (!sessionActive) return;
    void pollPendingUserMessages();
  }, 1500);

  if (runtimeId && attachUrl) {
    stopTunnel = startTunnelWorker(backend, apiKey, runtimeId, attachUrl, sessionId, {
      onUserFileEdit: handleUserFileEdit,
      onCancelTurn: handleCancelTurn,
      onUserMessage: enqueueUserMessage,
    });
  }

  const shutdownRuntime = async () => {
    sessionActive = false;
    clearInterval(inboundPollTimer);
    stopInbound();
    stopTunnel();
    stopHeartbeat();
    if (stopLiveSse) {
      stopLiveSse();
      stopLiveSse = null;
    }
    wakePromptWaiter();
    await commitAndPushDirtyWorktree("chimphands: commit before session idle/shutdown");
    await poster.flush();
    if (stopLlmProxy) {
      await stopLlmProxy().catch((err: unknown) => {
        console.error(
          `ChimpHands LLM retry proxy stop failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      stopLlmProxy = null;
    }
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
  // Bootstrap sets initialPrompt from the last pending user message AND returns
  // pendingUserMessages — enqueue only messages that are not the initial prompt
  // (otherwise the same turn runs twice: session=new then session=ses_…).
  const pending =
    boot.pending_user_messages || boot.pendingUserMessages || [];
  const initialNorm = normalizeUserMessage(prompt);
  for (const m of pending) {
    const content = normalizeUserMessage(m?.content || "");
    if (!content) continue;
    if (initialNorm && content === initialNorm) continue;
    const id =
      ("id" in m && m.id) ||
      ("message_id" in m && m.message_id) ||
      ("messageId" in m && m.messageId) ||
      undefined;
    enqueueUserMessage({ id: id || undefined, content });
  }

  const waitForNextPrompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      let lastPollAt = 0;
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        wakeWaitForPrompt = null;
        resolve(value);
      };
      wakeWaitForPrompt = () => {
        if (settled) return;
        if (queue.length) {
          finish(normalizeUserMessage(queue.shift()!));
          return;
        }
        if (idle || Date.now() - lastUserActivity >= idleMs) {
          finish(null);
        }
      };
      const tick = () => {
        if (settled) return;
        if (queue.length) {
          finish(normalizeUserMessage(queue.shift()!));
          return;
        }
        const now = Date.now();
        if (idle || now - lastUserActivity >= idleMs) {
          finish(null);
          return;
        }
        // Never gate the idle clock on consume_pending — a hung poll used to
        // block waitForNextPrompt forever and keep the Actions job alive.
        if (now - lastPollAt >= 1500) {
          lastPollAt = now;
          void pollPendingUserMessages().then(() => {
            if (settled) return;
            if (queue.length) {
              finish(normalizeUserMessage(queue.shift()!));
            }
          });
        }
        setTimeout(tick, 500);
      };
      tick();
    });

  while (prompt) {
    cancelTurnRequested = false;
    agentTurnInProgress = true;
    flushPendingMidTurnInject();
    let useOpencodeSessionId = opencodeSessionId;
    let isNewOpencodeSession = !useOpencodeSessionId;
    let effectivePrompt = wrapPromptWithContext(
      conversationSummary,
      prompt,
      isNewOpencodeSession,
      workingBranch,
      pullRequestUrl,
    );

    const turnPostEvent: RunOpencodeCallbacks["postEvent"] = (role, content, opts) =>
      postEventForTurn(prompt, effectivePrompt, role, content, opts);

    // Visible in chat (not filtered as routine). OpenCode may not emit text until a
    // part completes — without this the UI looks empty while the turn is running.
    postEvent(ROLE_STATUS, "Agent is working…", { status: STATUS_RUNNING });

    let result = await runOpencode(effectivePrompt, opencodeModel, childEnv, useOpencodeSessionId, {
      onSessionId: (id) => {
        opencodeSessionId = id;
        void postJson(backend, apiKey, "/api/chimphands/post_agent_event", {
          sessionId,
          opencodeSessionId: id,
        }).catch(() => {});
        flushPendingMidTurnInject();
      },
      onWorkingBranch: noteWorkingBranch,
      postEvent: turnPostEvent,
      ...turnControl,
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
          flushPendingMidTurnInject();
        },
        onWorkingBranch: noteWorkingBranch,
        postEvent: turnPostEvent,
        ...turnControl,
      }, attachUrl);
    }

    agentTurnInProgress = false;
    while (pendingMidTurnInject.length) {
      queue.push(pendingMidTurnInject.shift()!);
    }

    await poster.flush();

    if (result.opencodeSessionId) {
      opencodeSessionId = result.opencodeSessionId;
    }

    // Turn-end durable reconcile into PG (idempotent messageIds). Mid-turn was
    // ephemeral-only when UI attached; async runs get their transcript here.
    // Also reconcile on failure so partial assistant/tool output is not lost.
    if (attachUrl && opencodeSessionId) {
      try {
        await reconcileOpencodeSessionMessages(
          attachUrl,
          opencodeSessionId,
          (role, content, opts) => {
            turnPostEvent(role, content, {
              ...opts,
              opencodeSessionId,
              durable: true,
            });
          },
          noteWorkingBranch,
        );
        await poster.flush();
      } catch (err: unknown) {
        console.error(
          `ChimpHands turn-end reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Async / no UI: checkpoint dirty worktree after each turn so PR + Files changed
    // are reviewable when the user opens the session later (live VCS tunnel may be idle).
    if (!poster.uiAttached) {
      await commitAndPushDirtyWorktree("chimphands: commit after turn (async / no UI attached)");
    }

    if (result.code !== 0 && !result.cancelled) {
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
        await complete(STATUS_FAILED, errMsg);
      }
      exitCode = result.code || 1;
      break;
    }

    if (result.cancelled) {
      postEvent(ROLE_STATUS, "Turn stopped", { status: STATUS_WAITING_USER });
    } else {
      postEvent(ROLE_STATUS, "Waiting for user input", { status: STATUS_WAITING_USER });
    }
    await poster.flush();
    lastUserActivity = Date.now();
    idle = false;
    prompt = (await waitForNextPrompt()) || "";
  }

  if (exitCode == null) {
    console.error("ChimpHands session idle — no user input before timeout; completing.");
    await complete(STATUS_IDLE);
  }
  } finally {
    await shutdownRuntime();
  }
  // Always exit: tunnel WS / inbound SSE / heartbeat timers otherwise keep the
  // Actions step alive after a successful idle teardown.
  process.exit(exitCode ?? 0);
}

function startRuntimeHeartbeat(
  backend: string,
  apiKey: string,
  runtimeId: string,
  onUiAttached?: (attached: boolean) => void,
): () => void {
  let stopped = false;
  let lastAttached: boolean | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      // Do not claim tunnel_connected here — only the tunnel poll loop should.
      const text = await postJson(backend, apiKey, "/api/chimphands/runtime_heartbeat", {
        runtimeId,
      });
      try {
        const data = JSON.parse(text) as {
          uiAttached?: boolean;
          ui_attached?: boolean;
        };
        const attached = !!(data.uiAttached ?? data.ui_attached);
        // Always notify on false so syncLiveSse can accumulate detach hysteresis;
        // still skip duplicate true→true noise.
        if (attached !== lastAttached || !attached) {
          lastAttached = attached;
          onUiAttached?.(attached);
        }
      } catch {
        /* ignore parse */
      }
    } catch (err: unknown) {
      console.error(
        `ChimpHands runtime_heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!stopped) setTimeout(tick, 5_000);
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
    let push = await run(["push", "-u", "origin", "HEAD"]);
    if (push.code !== 0) {
      const detail = `${push.err || ""}\n${push.out || ""}`;
      console.error(`ChimpHands git push failed: ${push.err || push.out}`);
      try {
        const { looksLikeGitAuthFailure, refreshGitAuth } = await import("./refreshGitAuth.js");
        if (looksLikeGitAuthFailure(detail)) {
          console.error("ChimpHands reminting GitHub write token after push auth failure…");
          await refreshGitAuth();
          push = await run(["push", "-u", "origin", "HEAD"]);
          if (push.code !== 0) {
            console.error(`ChimpHands git push failed after refresh: ${push.err || push.out}`);
            return;
          }
        } else {
          return;
        }
      } catch (refreshErr: unknown) {
        console.error(
          `ChimpHands refresh-git-auth after push failure: ${
            refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
          }`,
        );
        return;
      }
    }
    console.error(`ChimpHands committed and pushed dirty worktree on ${current} before shutdown`);
  } catch (err: unknown) {
    console.error(
      `ChimpHands commit-before-idle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function opencodeProxyNeedsDirectory(path: string): boolean {
  const p = path.startsWith("/") ? path : `/${path}`;
  return (
    p.startsWith("/vcs") ||
    p.startsWith("/api/vcs") ||
    p.startsWith("/file") ||
    p.startsWith("/api/fs") ||
    p.startsWith("/api/session") ||
    p.startsWith("/path") ||
    p.startsWith("/session") ||
    p.startsWith("/instance") ||
    p.startsWith("/event") ||
    p.startsWith("/global/event")
  );
}

/** OpenCode workspace-scoped APIs require directory routing (header + query). */
export function appendOpencodeDirectoryRouting(
  path: string,
  query: string | undefined,
  headers: Record<string, string>,
  directory: string,
): string {
  if (!opencodeProxyNeedsDirectory(path)) {
    return query || "";
  }
  headers["x-opencode-directory"] = directory;
  if (query?.includes("directory=")) {
    return query;
  }
  const dirParam = `directory=${encodeURIComponent(directory)}`;
  return query ? `${query}&${dirParam}` : dirParam;
}

function startTunnelWorker(
  backend: string,
  apiKey: string,
  runtimeId: string,
  attachUrl: string,
  sessionId: string,
  handlers?: {
    onUserFileEdit?: (edit: { requestId: string; path: string; content: string }) => void;
    onCancelTurn?: () => void;
    onUserMessage?: (msg: InboundUserMessage) => void;
  },
  ): () => void {
  let stopped = false;
  const base = attachUrl.replace(/\/$/, "");
  const workDirectory = process.cwd();
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
    const pathPart = req.path || "/";
    const headers: Record<string, string> = { ...(req.headers || {}) };
    const query = appendOpencodeDirectoryRouting(pathPart, req.query, headers, workDirectory);
    const target = base + pathPart + (query ? `?${query}` : "");
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
          event?: string;
          data?: {
            sessionId?: string;
            requestId?: string;
            request_id?: string;
            path?: string;
            content?: string;
          };
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
        if (frame.type === "inbound_event" && frame.event === "cancel_turn") {
          const payload = frame.data as { sessionId?: string } | undefined;
          if (payload?.sessionId && payload.sessionId !== sessionId) {
            return;
          }
          console.error(`ChimpHands tunnel cancel_turn for session ${sessionId}`);
          handlers?.onCancelTurn?.();
          return;
        }
        if (frame.type === "inbound_event" && frame.event === "user_message" && frame.data) {
          const payload = frame.data as { sessionId?: string } | undefined;
          if (payload?.sessionId && payload.sessionId !== sessionId) {
            return;
          }
          const msg = parseInboundUserMessage(frame.data);
          if (msg) {
            console.error(`ChimpHands tunnel user_message for session ${sessionId}`);
            handlers?.onUserMessage?.(msg);
          }
          return;
        }
        if (frame.type === "inbound_event" && frame.event === "user_file_edit" && frame.data) {
          const edit = frame.data;
          if (edit.sessionId && edit.sessionId !== sessionId) {
            return;
          }
          const requestId = edit.requestId || edit.request_id;
          if (requestId && edit.path) {
            handlers?.onUserFileEdit?.({
              requestId,
              path: edit.path,
              content: edit.content ?? "",
            });
          }
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
  // Server is (re)started inside runChimphands after opencode.json is written.
  await runChimphands({ ...opts, attachUrl });
}
