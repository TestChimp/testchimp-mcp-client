/**
 * Remint a short-lived GitHub App installation token and apply it for git/gh.
 * Never prints the token. Safe for ChimpHands agents and GHA runners.
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { getBackendUrl, requireApiKey } from "../core/client.js";

export type RefreshGitAuthResult = {
  ok: true;
  repositoryFullName: string;
  expiresAtMillis: number;
};

type MintResponse = {
  token?: string;
  repositoryFullName?: string;
  repository_full_name?: string;
  expiresAtMillis?: number;
  expires_at_millis?: number;
};

function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
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
    child.on("error", (e) =>
      resolve({ code: 1, out: "", err: e instanceof Error ? e.message : String(e) }),
    );
  });
}

function pipeTokenToGh(token: string): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "login", "--with-token"], {
      stdio: ["pipe", "ignore", "pipe"],
      env: process.env,
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, err }));
    child.on("error", (e) =>
      resolve({ code: 1, err: e instanceof Error ? e.message : String(e) }),
    );
    child.stdin.write(token);
    child.stdin.end();
  });
}

function injectTokenIntoGithubHttpsUrl(remoteUrl: string, token: string): string | null {
  // https://github.com/owner/repo.git or https://x-access-token:OLD@github.com/owner/repo.git
  const m = remoteUrl.match(
    /^https:\/\/(?:[^@]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i,
  );
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, "");
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

async function mintGithubWriteToken(): Promise<{
  token: string;
  repositoryFullName: string;
  expiresAtMillis: number;
}> {
  const apiKey = requireApiKey();
  const backend = getBackendUrl();
  const res = await fetch(`${backend}/api/chimphands/github_write_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "TestChimp-Api-Key": apiKey,
    },
    body: "{}",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`github_write_token failed HTTP ${res.status}: ${text}`);
  }
  let parsed: MintResponse;
  try {
    parsed = JSON.parse(text) as MintResponse;
  } catch {
    throw new Error("github_write_token returned non-JSON");
  }
  const token = (parsed.token || "").trim();
  if (!token) {
    throw new Error("github_write_token returned empty token");
  }
  const repositoryFullName = (
    parsed.repositoryFullName ||
    parsed.repository_full_name ||
    ""
  ).trim();
  const expiresAtMillis =
    Number(parsed.expiresAtMillis ?? parsed.expires_at_millis) ||
    Date.now() + 60 * 60 * 1000;
  return { token, repositoryFullName, expiresAtMillis };
}

/**
 * Mint a ~1h GitHub App installation token and apply it for subsequent git/gh
 * in this process (and this GHA job when GITHUB_ENV is set).
 *
 * Does **not** print the token. Applies via:
 * - process.env GH_TOKEN / GITHUB_TOKEN
 * - $GITHUB_ENV when present (GitHub Actions)
 * - origin remote URL rewrite (https github.com) when possible
 * - `gh auth login --with-token` + `gh auth setup-git` when `gh` exists
 */
export async function refreshGitAuth(): Promise<RefreshGitAuthResult> {
  const { token, repositoryFullName, expiresAtMillis } = await mintGithubWriteToken();

  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;

  const githubEnvPath = process.env.GITHUB_ENV?.trim();
  if (githubEnvPath) {
    try {
      appendFileSync(githubEnvPath, `GH_TOKEN=${token}\nGITHUB_TOKEN=${token}\n`, "utf8");
    } catch (e: unknown) {
      console.error(
        `ChimpHands refresh-git-auth: could not write GITHUB_ENV: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  const remote = await run("git", ["remote", "get-url", "origin"]);
  if (remote.code === 0) {
    const current = remote.out.trim();
    const next = injectTokenIntoGithubHttpsUrl(current, token);
    if (next) {
      const set = await run("git", ["remote", "set-url", "origin", next]);
      if (set.code !== 0) {
        console.error(
          `ChimpHands refresh-git-auth: git remote set-url failed: ${set.err || set.out}`,
        );
      }
    }
  }

  const ghLogin = await pipeTokenToGh(token);
  if (ghLogin.code !== 0) {
    // setup-git alone still helps when login is already present / unavailable
    console.error(
      `ChimpHands refresh-git-auth: gh auth login skipped/failed: ${ghLogin.err || "non-zero"}`,
    );
  }
  const setup = await run("gh", ["auth", "setup-git"], {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  });
  if (setup.code !== 0) {
    console.error(
      `ChimpHands refresh-git-auth: gh auth setup-git: ${setup.err || setup.out}`,
    );
  }

  console.error(
    `ChimpHands refresh-git-auth: reminted GitHub App installation token` +
      (repositoryFullName ? ` for ${repositoryFullName}` : "") +
      ` (expires ~${new Date(expiresAtMillis).toISOString()})`,
  );

  return { ok: true, repositoryFullName, expiresAtMillis };
}

/** True when stderr/stdout looks like expired / rejected GitHub credentials. */
export function looksLikeGitAuthFailure(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /authentication failed|could not read username|invalid username or password|bad credentials|401\b|403\b|permission.*denied|remote:.*denied|write access not granted|repository not found/.test(
      t,
    ) || /gh:\s*to get started|gh auth login|HTTP\s*401|HTTP\s*403/.test(t)
  );
}
