import { Command, type ParseOptions } from "commander";

/** Printed when a release command is given `--version <label>` instead of `--release`. */
export const STRAY_RELEASE_VERSION_FLAG_MESSAGE =
  "Use --release <label> for a release version (or --release-version). --version / -V prints the CLI version only.";

/**
 * CLI commands that take a release catalog version / label.
 * `--version <value>` on these is a stray flag, not the global CLI version switch.
 */
export const RELEASE_LABEL_COMMANDS = new Set([
  "get-release",
  "get-release-details",
  "upsert-release",
  "manage-test-run",
  "get-requirement-coverage",
  "list-test-planning-trends",
  "get-execution-history",
  "list-execution-job-dimension-values",
  "ingest-scenario-execution",
  "list-test-scenarios-for-scope",
  "list-issues",
  "list-perf-runs",
  "get-truecoverage-events",
  "get-truecoverage-event-details",
  "get-truecoverage-child-event-tree",
  "get-truecoverage-event-transition",
  "get-truecoverage-event-time-series",
]);

export function addReleaseLabelOption(
  cmd: Command,
  description = "Release catalog version / label",
): Command {
  return cmd
    .option("--release <label>", description)
    .option("--release-version <label>", "Alias for --release");
}

/** Prefer `--release` over `--release-version`. */
export function cliReleaseLabel(opts: { release?: unknown; releaseVersion?: unknown }): string | undefined {
  const raw = opts.release ?? opts.releaseVersion;
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed || undefined;
}

/** MCP `version` field for get-release / upsert-release from CLI flags. */
export function cliReleaseVersionField(opts: {
  release?: unknown;
  releaseVersion?: unknown;
}): { version?: string } {
  const version = cliReleaseLabel(opts);
  return version ? { version } : {};
}

/**
 * Reject `--version <label>` on release commands so commander cannot treat it as
 * the global CLI version flag and silently print the package version.
 */
export function strayReleaseVersionError(argv: readonly string[]): string | undefined {
  if (!argv.some((t) => RELEASE_LABEL_COMMANDS.has(t))) return undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break;
    if (token.startsWith("--version=")) {
      if (token.slice("--version=".length).trim()) return STRAY_RELEASE_VERSION_FLAG_MESSAGE;
      continue;
    }
    if (token === "--version") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return STRAY_RELEASE_VERSION_FLAG_MESSAGE;
    }
  }
  return undefined;
}

/** Guard parse / parseAsync so a valued `--version` never prints the CLI version. */
export function installStrayReleaseVersionGuard(program: Command): void {
  const origParseAsync = program.parseAsync.bind(program);
  const origParse = program.parse.bind(program);
  program.parseAsync = ((argv?: readonly string[], options?: ParseOptions) => {
    const list = argv ? [...argv] : process.argv;
    const stray = strayReleaseVersionError(list);
    if (stray) return Promise.reject(new Error(stray));
    return origParseAsync(argv, options);
  }) as Command["parseAsync"];
  program.parse = ((argv?: readonly string[], options?: ParseOptions) => {
    const list = argv ? [...argv] : process.argv;
    const stray = strayReleaseVersionError(list);
    if (stray) throw new Error(stray);
    return origParse(argv, options);
  }) as Command["parse"];
}
