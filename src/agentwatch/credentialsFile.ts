/**
 * Local AgentWatch credentials in `~/.testchimp/agentwatch/credentials.json` (TESTCHIMP_HOME honoured).
 *
 * Written by `testchimp bot connect`, read by headless AgentWatch (desktop
 * `src/main/auth/agentwatchCredentials.ts`) so it runs without TestChimp Studio sign-in. Keyed by
 * project because the API key is per project. Holds the user's PAT: directory 0700, file 0600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getTestchimpHome, type RegistryEnv } from "../workspace/projectsRegistry.js";

export const AgentwatchProjectCredentialsSchema = z.looseObject({
  userId: z.string().min(1),
  email: z.string().optional(),
  userAuthKey: z.string().min(8),
  projectApiKey: z.string().min(8),
  botId: z.string().optional(),
  backendUrl: z.string().url(),
  ingressUrl: z.string().url().optional(),
  savedAtMillis: z.number().int().nonnegative(),
});

export type AgentwatchProjectCredentials = z.infer<typeof AgentwatchProjectCredentialsSchema>;

export const AgentwatchCredentialsFileSchema = z.looseObject({
  schemaVersion: z.literal(1),
  projects: z.record(z.string(), AgentwatchProjectCredentialsSchema),
});

export type AgentwatchCredentialsFile = z.infer<typeof AgentwatchCredentialsFileSchema>;

export function agentwatchCredentialsPath(env: RegistryEnv = {}): string {
  return join(getTestchimpHome(env), "agentwatch", "credentials.json");
}

/** Parsed file, or null when missing / unreadable / another schema. */
export function readAgentwatchCredentials(env: RegistryEnv = {}): AgentwatchCredentialsFile | null {
  const path = agentwatchCredentialsPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = AgentwatchCredentialsFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeAtomic(file: AgentwatchCredentialsFile, env: RegistryEnv): void {
  const path = agentwatchCredentialsPath(env);
  const dir = join(getTestchimpHome(env), "agentwatch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
}

export function saveProjectCredentials(
  projectId: string,
  creds: AgentwatchProjectCredentials,
  env: RegistryEnv = {},
): string {
  const entry = AgentwatchProjectCredentialsSchema.parse(creds);
  const file = readAgentwatchCredentials(env) ?? { schemaVersion: 1 as const, projects: {} };
  file.projects[projectId] = entry;
  writeAtomic(file, env);
  return agentwatchCredentialsPath(env);
}

/** True when an entry was removed. Deletes the file once no project is left. */
export function removeProjectCredentials(projectId: string, env: RegistryEnv = {}): boolean {
  const file = readAgentwatchCredentials(env);
  if (!file || !(projectId in file.projects)) return false;
  delete file.projects[projectId];
  if (Object.keys(file.projects).length === 0) {
    unlinkSync(agentwatchCredentialsPath(env));
  } else {
    writeAtomic(file, env);
  }
  return true;
}
