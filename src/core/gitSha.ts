import { execSync } from "node:child_process";

/** Current git HEAD when running in a repo; used when agents omit git_sha on report-agent-action. */
export function resolveGitHeadSha(provided?: string): string | undefined {
  const trimmed = provided?.trim();
  if (trimmed) {
    return trimmed;
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
