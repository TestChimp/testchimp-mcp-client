/**
 * `testchimp bot connect --pair` / `--finish-pair`: AgentWatch credentials without a second browser consent.
 *
 * Start keeps a random verifier in `~/.testchimp/agentwatch/pairing.json` (0600) and prints the pairing code
 * BASE64URL(SHA-256(verifier)). The QA bot approves that code with its own OAuth token
 * (`approve-agentwatch-pairing`, needs the consent-page "set up AgentWatch" opt-in). Finish redeems with the
 * verifier at `/bots/redeem_agentwatch_pairing` and stores the keys like `bot connect`. The bot only ever
 * sees the pairing code, which is useless without the verifier on this computer.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getTestchimpHome, type RegistryEnv } from "../workspace/projectsRegistry.js";
import { saveProjectCredentials } from "./credentialsFile.js";
import type { ConnectResult } from "./connect.js";

/** Matches the server's pairing TTL. */
export const PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_FINISH_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const PendingPairingSchema = z.looseObject({
  verifier: z.string().min(43),
  pairingCode: z.string().length(43),
  backendUrl: z.string().url(),
  ingressUrl: z.string().url().optional(),
  expectedProjectId: z.string().optional(),
  createdAtMillis: z.number().int().nonnegative(),
});

type PendingPairing = z.infer<typeof PendingPairingSchema>;

export type StartPairingOptions = {
  backendUrl: string;
  ingressUrl?: string;
  expectedProjectId?: string;
  env?: RegistryEnv;
};

export type StartPairingResult = {
  pairingCode: string;
  expiresAtMillis: number;
};

export type FinishPairingOptions = {
  /** When set, must match the backend the pairing was started against. */
  backendUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  env?: RegistryEnv;
};

export function pendingPairingPath(env: RegistryEnv = {}): string {
  return join(getTestchimpHome(env), "agentwatch", "pairing.json");
}

export function pairingCodeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function writePending(pending: PendingPairing, env: RegistryEnv): void {
  const path = pendingPairingPath(env);
  mkdirSync(join(getTestchimpHome(env), "agentwatch"), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
}

function readPending(env: RegistryEnv): PendingPairing | null {
  const path = pendingPairingPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = PendingPairingSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function clearPending(env: RegistryEnv): void {
  try {
    unlinkSync(pendingPairingPath(env));
  } catch {
    /* already gone */
  }
}

/** Replaces any earlier pending pairing on this computer. */
export function startAgentWatchPairing(opts: StartPairingOptions): StartPairingResult {
  const verifier = randomBytes(32).toString("base64url");
  const pairingCode = pairingCodeFor(verifier);
  const createdAtMillis = Date.now();
  writePending(
    {
      verifier,
      pairingCode,
      backendUrl: opts.backendUrl,
      ...(opts.ingressUrl ? { ingressUrl: opts.ingressUrl } : {}),
      ...(opts.expectedProjectId ? { expectedProjectId: opts.expectedProjectId } : {}),
      createdAtMillis,
    },
    opts.env ?? {},
  );
  return { pairingCode, expiresAtMillis: createdAtMillis + PAIRING_TTL_MS };
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function redeem(backendUrl: string, verifier: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${backendUrl}/bots/redeem_agentwatch_pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeVerifier: verifier }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail =
      stringField((body.responseHeader as Record<string, unknown>) ?? {}, "errorMessage") ?? text.slice(0, 200);
    if (res.status === 404) {
      throw new Error("This TestChimp deployment does not support AgentWatch pairing yet; use testchimp bot connect (browser)");
    }
    throw new Error(`Redeeming the AgentWatch pairing failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const creds = body.credentials;
  return creds && typeof creds === "object" ? (creds as Record<string, unknown>) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the bot has approved the pending pairing, then stores the credentials and removes the pending file. */
export async function finishAgentWatchPairing(opts: FinishPairingOptions = {}): Promise<ConnectResult> {
  const env = opts.env ?? {};
  const pending = readPending(env);
  if (!pending) {
    throw new Error("No pending AgentWatch pairing on this computer. Run: testchimp bot connect --pair");
  }
  if (Date.now() > pending.createdAtMillis + PAIRING_TTL_MS) {
    clearPending(env);
    throw new Error("The AgentWatch pairing expired. Run: testchimp bot connect --pair");
  }
  if (opts.backendUrl && opts.backendUrl !== pending.backendUrl) {
    throw new Error(
      `The pending pairing was started against ${pending.backendUrl}, not ${opts.backendUrl}. Run testchimp bot connect --pair again`,
    );
  }
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS);
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let creds: Record<string, unknown> | null = null;
  for (;;) {
    creds = await redeem(pending.backendUrl, pending.verifier);
    if (creds || Date.now() + interval > deadline) break;
    await sleep(interval);
  }
  if (!creds) {
    throw new Error(
      `The pairing code ${pending.pairingCode} has not been approved yet. Ask your QA bot to approve it, then run testchimp bot connect --finish-pair again`,
    );
  }

  const projectId = stringField(creds, "projectId");
  const userId = stringField(creds, "userId");
  const userAuthKey = stringField(creds, "userAuthKey");
  const projectApiKey = stringField(creds, "projectApiKey");
  if (!projectId || !userId || !userAuthKey || !projectApiKey) {
    throw new Error("AgentWatch credentials response was incomplete");
  }
  clearPending(env);
  if (pending.expectedProjectId && pending.expectedProjectId !== projectId) {
    throw new Error(
      `The bot approved project ${projectId}, not ${pending.expectedProjectId}; nothing was stored. Connect the bot to the right project and pair again`,
    );
  }
  const email = stringField(creds, "email");
  const botId = stringField(creds, "botId");
  const credentialsPath = saveProjectCredentials(
    projectId,
    {
      userId,
      ...(email ? { email } : {}),
      userAuthKey,
      projectApiKey,
      ...(botId ? { botId } : {}),
      backendUrl: pending.backendUrl,
      ...(pending.ingressUrl ? { ingressUrl: pending.ingressUrl } : {}),
      savedAtMillis: Date.now(),
    },
    env,
  );
  return { projectId, userId, ...(email ? { email } : {}), ...(botId ? { botId } : {}), credentialsPath };
}
