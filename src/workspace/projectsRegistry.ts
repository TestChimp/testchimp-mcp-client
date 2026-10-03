/**
 * Per-user folder ↔ project mapping in `~/.testchimp/projects.json` (TESTCHIMP_HOME honoured).
 *
 * Format contract shared with TestChimp Studio (desktop `src/main/workspace/projectsRegistry.ts`):
 * same schema v2, canonical real paths, conflict rule, v1 → v2 migration, atomic writes (0600) and
 * quarantine naming. `fixtures/projects-registry/` (mirrored byte-for-byte in the desktop repo)
 * pins the on-disk bytes both writers must produce.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { z } from "zod";

// Loose objects: fields written by a newer Studio survive a CLI rewrite.
export const WorkspaceFolderSchema = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().optional(),
});

export type WorkspaceFolder = z.infer<typeof WorkspaceFolderSchema>;

export const WorkspaceMappingSchema = z.looseObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().optional(),
  folders: z.array(WorkspaceFolderSchema).min(0),
  createdAtMillis: z.number().int().nonnegative(),
  lastOpenedAtMillis: z.number().int().nonnegative(),
  browserStartUrl: z.string().url().optional(),
});

export type WorkspaceMapping = z.infer<typeof WorkspaceMappingSchema>;

export const ProjectsRegistrySchema = z.looseObject({
  schemaVersion: z.literal(2),
  activeWorkspaceId: z.string().nullable(),
  mappings: z.array(WorkspaceMappingSchema),
});

export type ProjectsRegistry = z.infer<typeof ProjectsRegistrySchema>;

/** Injectable clock / id source (tests pin these to compare bytes with Studio). */
export type RegistryEnv = {
  home?: string;
  now?: () => number;
  newId?: () => string;
};

const EMPTY: ProjectsRegistry = { schemaVersion: 2, activeWorkspaceId: null, mappings: [] };

export function getTestchimpHome(env: RegistryEnv = {}): string {
  if (env.home) return env.home;
  const override = process.env.TESTCHIMP_HOME?.trim();
  if (override) return override;
  return join(homedir(), ".testchimp");
}

export function projectsRegistryPath(env: RegistryEnv = {}): string {
  return join(getTestchimpHome(env), "projects.json");
}

function nowOf(env: RegistryEnv): number {
  return env.now ? env.now() : Date.now();
}

function idOf(env: RegistryEnv): string {
  return env.newId ? env.newId() : randomUUID();
}

function ensureHome(env: RegistryEnv): void {
  const home = getTestchimpHome(env);
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** Serialized bytes exactly as written to disk (2-space JSON + trailing newline). */
export function serializeRegistry(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(path: string, value: unknown, env: RegistryEnv, mode = 0o600): void {
  ensureHome(env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeRegistry(value), { mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    /* ignore */
  }
}

/** Real absolute directory path (follows symlinks); same error codes as Studio. */
export function canonicalizePath(input: string): string {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("PATH_ESCAPE: empty path");
  const absolute = isAbsolute(trimmed) ? normalize(trimmed) : resolve(trimmed);
  if (!existsSync(absolute)) throw new Error("NOT_FOUND: path does not exist");
  if (!statSync(absolute).isDirectory()) throw new Error("INVALID_PAYLOAD: path is not a directory");
  try {
    return realpathSync(absolute);
  } catch {
    throw new Error("PATH_ESCAPE: cannot resolve real path");
  }
}

function folderNameFromPath(path: string): string {
  return basename(path) || path;
}

/** v1 → v2: single rootPath becomes folders[0]. */
function migrateRawRegistry(raw: unknown, env: RegistryEnv): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion === 2) return raw;
  if (obj.schemaVersion !== 1 || !Array.isArray(obj.mappings)) return raw;
  const mappings = obj.mappings.map((m: unknown) => {
    if (!m || typeof m !== "object") return m;
    const row = m as Record<string, unknown>;
    if (Array.isArray(row.folders)) return row;
    const rootPath = typeof row.rootPath === "string" ? row.rootPath : "";
    return {
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectName,
      folders: rootPath ? [{ id: idOf(env), path: rootPath, name: folderNameFromPath(rootPath) }] : [],
      createdAtMillis: row.createdAtMillis,
      lastOpenedAtMillis: row.lastOpenedAtMillis,
    };
  });
  return { schemaVersion: 2, activeWorkspaceId: obj.activeWorkspaceId ?? null, mappings };
}

function quarantine(env: RegistryEnv): string {
  const target = join(getTestchimpHome(env), `projects.invalid.${nowOf(env)}.json`);
  renameSync(projectsRegistryPath(env), target);
  return target;
}

/**
 * Read projects.json for a write. Missing → empty file created; v1 → migrated + persisted;
 * schema-invalid or unparseable → moved to `projects.invalid.<millis>.json` and reset to empty.
 */
export function readProjectsRegistry(env: RegistryEnv = {}): ProjectsRegistry {
  ensureHome(env);
  const path = projectsRegistryPath(env);
  if (!existsSync(path)) {
    writeJsonAtomic(path, EMPTY, env);
    return { ...EMPTY, mappings: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    quarantine(env);
    writeJsonAtomic(path, EMPTY, env);
    return { ...EMPTY, mappings: [] };
  }
  const parsed = ProjectsRegistrySchema.safeParse(migrateRawRegistry(raw, env));
  if (!parsed.success) {
    quarantine(env);
    writeJsonAtomic(path, EMPTY, env);
    return { ...EMPTY, mappings: [] };
  }
  if ((raw as { schemaVersion?: number }).schemaVersion !== 2) {
    writeJsonAtomic(path, parsed.data, env);
  }
  return parsed.data;
}

/** Side-effect-free lookup for `workspace get` (never creates, migrates, or quarantines). */
export function findWorkspaceMapping(projectId: string, env: RegistryEnv = {}): WorkspaceMapping | null {
  const path = projectsRegistryPath(env);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`INVALID_REGISTRY: ${path} is not valid JSON`);
  }
  const migrated = migrateRawRegistry(raw, { ...env, newId: () => "migrated" });
  const parsed = ProjectsRegistrySchema.safeParse(migrated);
  if (!parsed.success) throw new Error(`INVALID_REGISTRY: ${path} does not match schema v2`);
  return parsed.data.mappings.find((m) => m.projectId === projectId) ?? null;
}

function saveRegistry(registry: ProjectsRegistry, env: RegistryEnv): ProjectsRegistry {
  const next = ProjectsRegistrySchema.parse(registry);
  writeJsonAtomic(projectsRegistryPath(env), next, env);
  return next;
}

export type FolderMappingConflict = { projectId: string; projectName?: string };

function conflictIn(registry: ProjectsRegistry, projectId: string, root: string): FolderMappingConflict | null {
  for (const m of registry.mappings) {
    if (m.projectId === projectId) continue;
    if (m.folders.some((f) => f.path === root)) {
      return { projectId: m.projectId, ...(m.projectName ? { projectName: m.projectName } : {}) };
    }
  }
  return null;
}

/** Remove `root` from every mapping that is not `projectId`; drop empty rows. */
function stripFolderFromOtherProjects(mappings: WorkspaceMapping[], projectId: string, root: string): WorkspaceMapping[] {
  return mappings
    .map((m) => {
      if (m.projectId === projectId) return m;
      if (!m.folders.some((f) => f.path === root)) return m;
      return { ...m, folders: m.folders.filter((f) => f.path !== root) };
    })
    .filter((m) => m.projectId === projectId || m.folders.length > 0);
}

export type UpsertWorkspaceFolderInput = {
  projectId: string;
  projectName?: string;
  rootPath: string;
  /** When true, steal `rootPath` from another project's mapping if present. */
  reassign?: boolean;
};

/**
 * Ensure a project workspace exists and add `rootPath` as a folder (or refresh if already present).
 * Rejects if the path is mapped to a different project unless `reassign` is set.
 */
export function upsertWorkspaceFolder(input: UpsertWorkspaceFolderInput, env: RegistryEnv = {}): WorkspaceMapping {
  const root = canonicalizePath(input.rootPath);
  const reg = readProjectsRegistry(env);

  const conflict = conflictIn(reg, input.projectId, root);
  if (conflict && !input.reassign) {
    throw new Error(`INVALID_PAYLOAD: folder already mapped to project ${conflict.projectId}`);
  }

  let baseMappings = reg.mappings;
  if (conflict && input.reassign) {
    baseMappings = stripFolderFromOtherProjects(baseMappings, input.projectId, root);
  }

  const now = nowOf(env);
  const existing = baseMappings.find((m) => m.projectId === input.projectId);
  let mapping: WorkspaceMapping;
  let mappings: WorkspaceMapping[];

  if (existing) {
    const already = existing.folders.find((f) => f.path === root);
    const folders = already
      ? existing.folders.map((f) => (f.path === root ? { ...f, path: root, name: f.name || folderNameFromPath(root) } : f))
      : [...existing.folders, { id: idOf(env), path: root, name: folderNameFromPath(root) }];
    mapping = {
      ...existing,
      projectName: input.projectName ?? existing.projectName,
      folders,
      lastOpenedAtMillis: now,
    };
    mappings = baseMappings.map((m) => (m.id === existing.id ? mapping : m));
  } else {
    mapping = {
      id: idOf(env),
      projectId: input.projectId,
      projectName: input.projectName,
      folders: [{ id: idOf(env), path: root, name: folderNameFromPath(root) }],
      createdAtMillis: now,
      lastOpenedAtMillis: now,
    };
    mappings = [...baseMappings, mapping];
  }

  const saved = saveRegistry({ ...reg, schemaVersion: 2, activeWorkspaceId: mapping.id, mappings }, env);
  return saved.mappings.find((m) => m.id === mapping.id)!;
}
