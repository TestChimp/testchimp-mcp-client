/**
 * ChimpHands CI git: base branch (parent) vs agent branch (testchimp-* only).
 */

import { spawn } from "node:child_process";

export const BASE_BRANCH_PREFIX = "Base branch: ";
/** @deprecated Legacy platform line; still parsed for in-flight sessions. */
export const LEGACY_WORKING_BRANCH_PREFIX = "Working branch: ";

const BASE_BRANCH_LINE =
  /^(?:Base branch|Working branch):\s*(.+)$/im;

const AGENT_BRANCH_PREFIX = /^testchimp-/i;

export function isAgentBranchName(branch: string): boolean {
  return AGENT_BRANCH_PREFIX.test(branch.trim());
}

export function parseBaseBranchFromPrompt(prompt: string): string | undefined {
  if (!prompt?.trim()) return undefined;
  let last: string | undefined;
  for (const line of prompt.split("\n")) {
    const m = line.match(BASE_BRANCH_LINE);
    if (!m?.[1]) continue;
    const candidate = m[1].trim();
    if (candidate) last = candidate;
  }
  return last;
}

export function resolveSessionBaseBranch(
  prompt: string | undefined,
  envBaseBranch?: string,
): string | undefined {
  const fromPrompt = prompt ? parseBaseBranchFromPrompt(prompt) : undefined;
  if (fromPrompt) return fromPrompt;
  const fromEnv = envBaseBranch?.trim();
  return fromEnv || undefined;
}

export function buildAgentBranchName(sessionId: string): string {
  const slug = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toLowerCase() || "session";
  return `testchimp-chimphands-${slug}`;
}

type GitRunResult = { code: number; out: string; err: string };

export function runGit(args: string[], env?: NodeJS.ProcessEnv): Promise<GitRunResult> {
  return new Promise((resolve) => {
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
}

async function currentBranch(): Promise<string | undefined> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) return undefined;
  const b = r.out.trim();
  return b && b !== "HEAD" ? b : undefined;
}

async function isDirtyWorktree(): Promise<boolean> {
  const r = await runGit(["status", "--porcelain"]);
  return r.code === 0 && !!r.out.trim();
}

export type EnsureAgentBranchOptions = {
  sessionId: string;
  baseBranch?: string;
  /** Agent branch already reported for this session (bootstrap). */
  existingAgentBranch?: string;
};

export type EnsureAgentBranchResult = {
  agentBranch: string;
  baseBranch?: string;
  created: boolean;
};

/**
 * Ensures the runner is on a published testchimp-* agent branch.
 * When checked out on the user's base branch, creates testchimp-chimphands-<session> from it.
 */
export async function ensureAgentSessionBranch(
  opts: EnsureAgentBranchOptions,
): Promise<EnsureAgentBranchResult> {
  const baseBranch = opts.baseBranch?.trim() || undefined;
  const existing = opts.existingAgentBranch?.trim();
  if (existing && isAgentBranchName(existing)) {
    await checkoutLocalBranch(existing);
    return { agentBranch: existing, baseBranch, created: false };
  }

  const current = await currentBranch();
  if (current && isAgentBranchName(current)) {
    return { agentBranch: current, baseBranch, created: false };
  }

  const agentBranch = buildAgentBranchName(opts.sessionId);
  const create = await runGit(["checkout", "-b", agentBranch]);
  if (create.code !== 0) {
    throw new Error(
      `git checkout -b ${agentBranch} failed: ${create.err || create.out || "unknown"}`,
    );
  }

  const push = await runGit(["push", "-u", "origin", "HEAD"]);
  if (push.code !== 0) {
    throw new Error(`git push failed for new agent branch: ${push.err || push.out || "unknown"}`);
  }

  console.error(
    `ChimpHands created agent branch ${agentBranch}` +
      (baseBranch ? ` from base ${baseBranch}` : ""),
  );
  return { agentBranch, baseBranch, created: true };
}

async function checkoutLocalBranch(branch: string): Promise<void> {
  const r = await runGit(["checkout", branch]);
  if (r.code !== 0) {
    throw new Error(`git checkout ${branch} failed: ${r.err || r.out || "unknown"}`);
  }
}

export type EnsurePullRequestOptions = {
  agentBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
};

/** Opens a PR from agent branch → base branch when none exists. Returns PR URL if created/found. */
export async function ensurePullRequest(
  opts: EnsurePullRequestOptions,
): Promise<string | undefined> {
  const agentBranch = opts.agentBranch.trim();
  const baseBranch = opts.baseBranch.trim();
  if (!agentBranch || !baseBranch || agentBranch === baseBranch) return undefined;

  const list = await runGh([
    "pr",
    "list",
    "--head",
    agentBranch,
    "--base",
    baseBranch,
    "--state",
    "open",
    "--json",
    "url",
    "--jq",
    ".[0].url",
  ]);
  if (list.code === 0 && list.out.trim()) {
    return list.out.trim();
  }

  const dirty = await isDirtyWorktree();
  if (dirty) {
    return undefined;
  }

  const headAhead = await runGit(["rev-list", "--count", `${baseBranch}..${agentBranch}`]);
  const aheadCount = Number.parseInt(headAhead.out.trim(), 10);
  if (headAhead.code !== 0 || !Number.isFinite(aheadCount) || aheadCount <= 0) {
    return undefined;
  }

  const title = opts.title?.trim() || `ChimpHands: ${agentBranch}`;
  const body =
    opts.body?.trim() ||
    `Automated changes from ChimpHands session on branch \`${agentBranch}\`.\n\nMerge target: \`${baseBranch}\`.`;
  const create = await runGh([
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    agentBranch,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (create.code !== 0) {
    console.error(`ChimpHands gh pr create failed: ${create.err || create.out}`);
    return undefined;
  }
  const url = (create.out || create.err).trim().match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
  return url;
}

function runGh(args: string[]): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
}

export function isPrOnlyMode(): boolean {
  const v = (process.env.CHIMPHANDS_PR_ONLY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
