/**
 * Project API key for local runners in `<repo>/.testchimp/mcp.json` — the file TestChimp Studio writes when a
 * folder is mapped (desktop `src/main/workspace/mcpLifecycle.ts`). Same shape, mode 0600, gitignored
 * `.testchimp/`, other servers kept. `fixtures/workspace-mcp-json/` (mirrored in the desktop repo) pins the bytes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_BACKEND, isValidProjectId } from "../core/client.js";
import { canonicalizePath } from "./projectsRegistry.js";

export const WORKSPACE_DIR = ".testchimp";
const SERVER_NAME = "testchimp";
const GITIGNORE_ENTRY = ".testchimp/";
const GITIGNORE_ALIASES = new Set([GITIGNORE_ENTRY, ".testchimp", "/.testchimp/", "/.testchimp"]);

export type WorkspaceCredsInput = {
  apiKey: string;
  projectId: string;
  backendUrl: string;
  ingressUrl?: string;
};

type ServerEntry = Record<string, unknown> & { env?: Record<string, string> };

/** Studio's managed testchimp entry (npx form; Studio swaps in its managed binary when installed). */
export function buildTestchimpServerEntry(input: WorkspaceCredsInput): ServerEntry {
  const env: Record<string, string> = {
    TESTCHIMP_API_KEY: input.apiKey,
    TESTCHIMP_PROJECT_ID: input.projectId,
  };
  const backend = input.backendUrl.replace(/\/+$/, "");
  if (backend && backend !== DEFAULT_BACKEND) env.TESTCHIMP_BACKEND_URL = backend;
  const ingress = (input.ingressUrl ?? "").replace(/\/+$/, "");
  if (ingress) env.TESTCHIMP_INGRESS_URL = ingress;
  return { command: "npx", args: ["-y", "@testchimp/cli@latest", "mcp"], env, enabled: true };
}

export function serializeMcpJson(servers: Record<string, unknown>): string {
  return `${JSON.stringify({ schemaVersion: 1, mcpServers: servers }, null, 2)}\n`;
}

export function workspaceMcpJsonPath(root: string): string {
  return join(root, WORKSPACE_DIR, "mcp.json");
}

function writeAtomic(path: string, contents: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, contents, { mode, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    chmodSync(path, mode);
  } catch {
    /* ignore */
  }
}

function readServers(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`INVALID_MCP_JSON: ${path} is not valid JSON; fix or remove it first`);
  }
  const servers = raw && typeof raw === "object" ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  if (servers == null) return {};
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`INVALID_MCP_JSON: ${path} mcpServers must be an object`);
  }
  return { ...(servers as Record<string, unknown>) };
}

/** Same rule as Studio's ensureGitignoreHasTestchimp. Returns true when .gitignore was created or changed. */
export function ensureGitignoreHasTestchimp(root: string): boolean {
  const gi = join(root, ".gitignore");
  if (!existsSync(gi)) {
    writeAtomic(gi, `${GITIGNORE_ENTRY}\n`, 0o644);
    return true;
  }
  const raw = readFileSync(gi, "utf8");
  if (raw.split(/\r?\n/).some((l) => GITIGNORE_ALIASES.has(l.trim()))) return false;
  const suffix = raw.endsWith("\n") || raw.length === 0 ? "" : "\n";
  writeAtomic(gi, `${raw}${suffix}\n# TestChimp Studio local project config (credentials)\n${GITIGNORE_ENTRY}\n`, 0o644);
  return true;
}

export type SaveWorkspaceCredsResult = {
  status: "written" | "updated" | "unchanged";
  folder: string;
  mcpJsonPath: string;
  gitignoreUpdated: boolean;
};

export type PlannedWorkspaceCreds = {
  root: string;
  path: string;
  status: SaveWorkspaceCredsResult["status"];
  contents?: string;
};

/**
 * Decide what to write without touching disk. An existing entry for the same project keeps its launch
 * command (e.g. Studio's managed binary) and only gets the key refreshed; another project's entry is refused
 * unless `reassign`.
 */
export function planWorkspaceCreds(
  folder: string,
  input: WorkspaceCredsInput,
  opts: { reassign?: boolean } = {},
): PlannedWorkspaceCreds {
  if (!input.apiKey.trim()) throw new Error("INVALID_PAYLOAD: empty project API key");
  if (/\s/.test(input.apiKey.trim())) throw new Error("INVALID_PAYLOAD: the project API key must be a single token");
  if (!isValidProjectId(input.projectId)) throw new Error("INVALID_PAYLOAD: --project-id must match [A-Za-z0-9_-]{1,64}");
  const root = canonicalizePath(folder);
  const path = workspaceMcpJsonPath(root);
  const servers = readServers(path);
  const existingKey = Object.keys(servers).find((name) => name.trim().toLowerCase() === SERVER_NAME);
  const existing = existingKey ? (servers[existingKey] as ServerEntry) : undefined;
  const existingEnv = existing && typeof existing.env === "object" && existing.env ? existing.env : undefined;
  const existingProject = existingEnv?.TESTCHIMP_PROJECT_ID?.trim();

  if (existingProject && existingProject !== input.projectId && !opts.reassign) {
    throw new Error(
      `INVALID_PAYLOAD: ${path} is set up for project ${existingProject}; pass --reassign to switch it to ${input.projectId}`,
    );
  }

  let next: ServerEntry;
  let status: SaveWorkspaceCredsResult["status"];
  if (existing && existingProject === input.projectId) {
    if (existingEnv?.TESTCHIMP_API_KEY === input.apiKey) return { root, path, status: "unchanged" };
    next = { ...existing, env: { ...existingEnv, TESTCHIMP_API_KEY: input.apiKey } };
    status = "updated";
  } else {
    next = buildTestchimpServerEntry(input);
    status = existing ? "updated" : "written";
  }

  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (name !== existingKey) out[name] = entry;
  }
  out[SERVER_NAME] = next;
  return { root, path, status, contents: serializeMcpJson(out) };
}

export function writePlannedWorkspaceCreds(plan: PlannedWorkspaceCreds): SaveWorkspaceCredsResult {
  if (plan.contents != null) {
    const dir = join(plan.root, WORKSPACE_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(plan.path, plan.contents, 0o600);
  }
  const gitignoreUpdated = ensureGitignoreHasTestchimp(plan.root);
  return { status: plan.status, folder: plan.root, mcpJsonPath: plan.path, gitignoreUpdated };
}

const FALLBACK_ENV_KEYS = ["TESTCHIMP_API_KEY", "TESTCHIMP_PROJECT_ID", "TESTCHIMP_BACKEND_URL", "TESTCHIMP_INGRESS_URL"];

function isPlaceholderKey(value: string): boolean {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value) || /paste_your|placeholder|your_project|changeme/i.test(value);
}

/**
 * Studio and `workspace save-creds` write the file 0600. A group/world-readable or foreign-owned copy (e.g.
 * committed to a cloned repo) could point the CLI at another backend, so it is not trusted.
 */
function isPrivateFile(path: string): boolean {
  if (process.platform === "win32") return true;
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== "function" || st.uid === process.getuid();
}

/**
 * Runner env (key, project, backend / ingress) from the nearest `.testchimp/mcp.json` at or above `startDir`
 * whose testchimp entry holds a real key (placeholders like `${TESTCHIMP_API_KEY}` are skipped). Files that
 * are not private to the current user are skipped and reported through `onIgnored`.
 */
export function findWorkspaceCredsEnv(
  startDir: string,
  onIgnored?: (path: string) => void,
): { env: Record<string, string>; path: string } | null {
  let dir = resolve(startDir);
  for (;;) {
    const path = workspaceMcpJsonPath(dir);
    if (existsSync(path)) {
      try {
        const servers = readServers(path);
        const name = Object.keys(servers).find((n) => n.trim().toLowerCase() === SERVER_NAME);
        const entryEnv = name ? (servers[name] as ServerEntry).env : undefined;
        const apiKey = typeof entryEnv?.TESTCHIMP_API_KEY === "string" ? entryEnv.TESTCHIMP_API_KEY.trim() : "";
        if (entryEnv && apiKey && !isPlaceholderKey(apiKey)) {
          if (!isPrivateFile(path)) {
            onIgnored?.(path);
          } else {
            const env: Record<string, string> = {};
            for (const key of FALLBACK_ENV_KEYS) {
              const value = entryEnv[key];
              if (typeof value === "string" && value.trim()) env[key] = value.trim();
            }
            return { env, path };
          }
        }
      } catch {
        /* unreadable file: keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * CLI only: when the shell has neither TESTCHIMP_API_KEY nor TESTCHIMP_OAUTH_TOKEN, take the runner env from
 * the nearest `.testchimp/mcp.json`. Exported variables always win. Returns the file used, if any; notes
 * (ignored files, an exported backend that differs from the file's) go to `warn`.
 */
export function applyWorkspaceCredsFallback(
  env: NodeJS.ProcessEnv,
  cwd: string,
  warn: (message: string) => void = () => {},
): string | null {
  if (env.TESTCHIMP_API_KEY?.trim() || env.TESTCHIMP_OAUTH_TOKEN?.trim()) return null;
  const found = findWorkspaceCredsEnv(cwd, (path) =>
    warn(`Ignoring ${path}: it must be private to you (chmod 600) before the CLI reads its API key`),
  );
  if (!found) return null;
  const exportedBackend = env.TESTCHIMP_BACKEND_URL?.trim().replace(/\/+$/, "");
  const fileBackend = (found.env.TESTCHIMP_BACKEND_URL ?? DEFAULT_BACKEND).replace(/\/+$/, "");
  if (exportedBackend && exportedBackend !== fileBackend) {
    warn(`TESTCHIMP_BACKEND_URL (${exportedBackend}) differs from ${found.path} (${fileBackend}); the key may be rejected`);
  }
  for (const [key, value] of Object.entries(found.env)) {
    if (!env[key]?.trim()) env[key] = value;
  }
  return found.path;
}
