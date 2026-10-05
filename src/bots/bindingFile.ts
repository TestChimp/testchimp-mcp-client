/**
 * QA bot project binding for the CLI: `~/.testchimp/bots/<botId>.json` (TESTCHIMP_HOME honoured).
 *
 * Several QA bots (one per project) can share one computer, so the project API key is kept per bot and
 * loaded per command with `--bot <botId>` instead of living in shell env or rc files. Directory 0700,
 * file 0600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getTestchimpHome, type RegistryEnv } from "../workspace/projectsRegistry.js";

const BOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const BotBindingSchema = z.looseObject({
  schemaVersion: z.literal(1),
  botId: z.string().regex(BOT_ID_PATTERN),
  projectId: z.string().min(1),
  projectName: z.string().optional(),
  projectApiKey: z.string().min(8),
  backendUrl: z.string().url().optional(),
  ingressUrl: z.string().url().optional(),
  savedAtMillis: z.number().int().nonnegative(),
});

export type BotBinding = z.infer<typeof BotBindingSchema>;

/** Bot ids become file names: letters, digits, dot, underscore and dash only. */
export function assertBotId(botId: string): string {
  const id = botId.trim();
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid bot id ${JSON.stringify(botId)}: use the botId from get-bot-credentials`);
  }
  return id;
}

export function botBindingPath(botId: string, env: RegistryEnv = {}): string {
  return join(getTestchimpHome(env), "bots", `${assertBotId(botId)}.json`);
}

export function saveBotBinding(binding: Omit<BotBinding, "schemaVersion">, env: RegistryEnv = {}): string {
  const entry = BotBindingSchema.parse({ schemaVersion: 1, ...binding });
  const path = botBindingPath(entry.botId, env);
  mkdirSync(join(getTestchimpHome(env), "bots"), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  return path;
}

/** Parsed binding, or null when missing / unreadable / another schema. */
export function readBotBinding(botId: string, env: RegistryEnv = {}): BotBinding | null {
  const path = botBindingPath(botId, env);
  if (!existsSync(path)) return null;
  try {
    const parsed = BotBindingSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function removeBotBinding(botId: string, env: RegistryEnv = {}): boolean {
  const path = botBindingPath(botId, env);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Points this process at the bot's binding: TESTCHIMP_API_KEY, TESTCHIMP_BOT_ID and (when stored) the
 * backend / ingress URLs. The binding wins over inherited env so a shell another bot left behind cannot
 * redirect this bot to the wrong project. TESTCHIMP_OAUTH_TOKEN is dropped for the same reason.
 */
export function applyBotBinding(botId: string, env: RegistryEnv = {}): BotBinding {
  const binding = readBotBinding(botId, env);
  if (!binding) {
    throw new Error(
      `No TestChimp binding for bot ${botId} on this computer (${botBindingPath(botId, env)}). ` +
        "Run: testchimp bot save-binding --bot-id <botId> --project-id <projectId> (key on stdin)"
    );
  }
  process.env.TESTCHIMP_API_KEY = binding.projectApiKey;
  process.env.TESTCHIMP_BOT_ID = binding.botId;
  delete process.env.TESTCHIMP_OAUTH_TOKEN;
  if (binding.backendUrl) process.env.TESTCHIMP_BACKEND_URL = binding.backendUrl;
  if (binding.ingressUrl) process.env.TESTCHIMP_INGRESS_URL = binding.ingressUrl;
  return binding;
}
