/**
 * Paths that must not be committed on the agent branch.
 *
 * Worktree-resident (needed at runtime, never product):
 * - opencode.json, .agents/**
 *
 * Legacy / accidental worktree pollution (now written under /tmp when possible):
 * - *.log runner logs, .chimphands/**, remote-branch*.txt, gha-creds*
 */
export function isChimpHandsInternalCommitPath(filePath: string): boolean {
  let normalized = filePath.replace(/\\/g, "/").toLowerCase();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  const slash = normalized.lastIndexOf("/");
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (
    name === "opencode.json" ||
    name === "opencode-server.log" ||
    name === "chimphands-run.log" ||
    name === "remote-branches.txt" ||
    name === "remote-branch-names.txt" ||
    name.startsWith("gha-creds")
  ) {
    return true;
  }
  return (
    normalized === ".chimphands" ||
    normalized.startsWith(".chimphands/") ||
    normalized === ".agents" ||
    normalized.startsWith(".agents/")
  );
}

/** Parse paths from `git status --porcelain` (newline form, not -z). */
export function pathsFromGitPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const raw of porcelain.split("\n")) {
    if (!raw || raw.length < 4) continue;
    let body = raw.slice(3);
    if (body.includes(" -> ")) {
      body = body.slice(body.lastIndexOf(" -> ") + 4);
    }
    if (body.startsWith('"') && body.endsWith('"')) {
      body = body
        .slice(1, -1)
        .replace(/\\([\\"nt])/g, (_m, c: string) => {
          if (c === "n") return "\n";
          if (c === "t") return "\t";
          return c;
        });
    }
    if (body) paths.push(body);
  }
  return paths;
}

/** Dirty worktree paths that are eligible to commit on the agent branch. */
export function commitCandidatePathsFromPorcelain(porcelain: string): string[] {
  return pathsFromGitPorcelain(porcelain).filter((p) => !isChimpHandsInternalCommitPath(p));
}

export function normalizeWorktreePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

/** Intersect status candidates with an optional path allowlist (e.g. a single UI save). */
export function resolveCommitPaths(
  porcelain: string,
  onlyPaths?: string[],
): string[] {
  const candidates = commitCandidatePathsFromPorcelain(porcelain);
  if (!onlyPaths?.length) return candidates;
  const want = new Set(onlyPaths.map(normalizeWorktreePath));
  return candidates.filter((p) => want.has(normalizeWorktreePath(p)));
}
