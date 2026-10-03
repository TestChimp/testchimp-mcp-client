/** Local git inspection for `testchimp workspace map` (same rules as TestChimp Studio folder mapping). */

import { spawnSync } from "node:child_process";
import { canonicalizePath } from "./projectsRegistry.js";

function runGit(cwd: string, args: string[]): { code: number; stdout: string } {
  const res = spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  return { code: res.status ?? 1, stdout: res.stdout ?? "" };
}

function cleanFullName(pathOrName: string): string | null {
  const cleaned = String(pathOrName ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .trim();
  if (!cleaned || cleaned.includes("..")) return null;
  return cleaned;
}

/** Normalize a git remote URL to `owner/repo` (or GitLab nested path); host is ignored. */
export function normalizeGitRemoteToFullName(remoteUrl: string | undefined | null): string | null {
  let raw = String(remoteUrl ?? "").trim();
  if (!raw) return null;
  raw = raw.replace(/\.git$/i, "");
  const scp = raw.match(/^git@[^:]+:(.+)$/);
  if (scp?.[1]) return cleanFullName(scp[1]);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    try {
      return cleanFullName(new URL(raw).pathname);
    } catch {
      return null;
    }
  }
  if (raw.includes("/") && !raw.startsWith("~")) return cleanFullName(raw);
  return null;
}

/** Case-insensitive compare of repositoryFullName values. */
export function repositoryFullNamesMatch(expected: string | undefined | null, actual: string | undefined | null): boolean {
  const a = String(expected ?? "").trim().replace(/\.git$/i, "").toLowerCase();
  const b = String(actual ?? "").trim().replace(/\.git$/i, "").toLowerCase();
  return Boolean(a && b && a === b);
}

export type LocalGitRepoInspection = {
  selectedPath: string;
  /** Canonical git toplevel, or null if not a work tree. */
  toplevelPath: string | null;
  isRepoRoot: boolean;
  remoteFullNames: string[];
};

export function inspectLocalGitRepo(folderPath: string): LocalGitRepoInspection {
  const selectedPath = canonicalizePath(folderPath);
  const inside = runGit(selectedPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { selectedPath, toplevelPath: null, isRepoRoot: false, remoteFullNames: [] };
  }
  const top = runGit(selectedPath, ["rev-parse", "--show-toplevel"]);
  let toplevelPath: string | null = null;
  if (top.code === 0 && top.stdout.trim()) {
    try {
      toplevelPath = canonicalizePath(top.stdout.trim());
    } catch {
      toplevelPath = null;
    }
  }
  const remoteFullNames: string[] = [];
  const remotes = runGit(selectedPath, ["remote", "-v"]);
  if (remotes.code === 0) {
    for (const line of remotes.stdout.split("\n")) {
      const m = line.match(/^\S+\s+(\S+)\s+/);
      if (!m?.[1]) continue;
      const full = normalizeGitRemoteToFullName(m[1]);
      if (full && !remoteFullNames.some((n) => repositoryFullNamesMatch(n, full))) remoteFullNames.push(full);
    }
  }
  const prefix = runGit(selectedPath, ["rev-parse", "--show-prefix"]);
  const isRepoRoot = prefix.code === 0 && prefix.stdout.replace(/\\/g, "/").trim() === "";
  return { selectedPath, toplevelPath, isRepoRoot, remoteFullNames };
}

/**
 * Throw a user-visible error unless `inspection` is a git work tree; when `expectedRepositoryFullName`
 * is known, also require the repository root and a matching remote.
 */
export function assertFolderMatchesRepo(inspection: LocalGitRepoInspection, expectedRepositoryFullName: string | null): void {
  if (!inspection.toplevelPath) {
    throw new Error(
      `NOT_A_GIT_REPO: ${inspection.selectedPath} is not a Git repository${
        expectedRepositoryFullName ? ` (connected repo: ${expectedRepositoryFullName})` : ""
      }.`,
    );
  }
  const expected = String(expectedRepositoryFullName ?? "").trim();
  if (!expected) return;
  if (!inspection.isRepoRoot) {
    throw new Error(
      `NOT_REPO_ROOT: folder is inside a Git repository but is not its root. Use ${inspection.toplevelPath} (connected repo: ${expected}).`,
    );
  }
  if (!inspection.remoteFullNames.some((n) => repositoryFullNamesMatch(expected, n))) {
    const found = inspection.remoteFullNames.length > 0 ? inspection.remoteFullNames.join(", ") : "none";
    throw new Error(
      `REPO_MISMATCH: this folder's Git remote does not match the repository connected to the project (expected: ${expected}; found: ${found}).`,
    );
  }
}
