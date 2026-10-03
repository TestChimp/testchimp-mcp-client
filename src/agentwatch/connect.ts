/**
 * `testchimp bot connect`: OAuth 2.1 (PKCE, loopback redirect) against the TestChimp authorization
 * server with the opt-in `agentwatch` scope, then one call to `/bots/get_agentwatch_credentials` to
 * fetch the user id, PAT and project API key, stored for headless AgentWatch. Nothing secret is
 * printed; the refresh token is revoked straight away because the stored credentials replace it.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { saveProjectCredentials } from "./credentialsFile.js";
import type { RegistryEnv } from "../workspace/projectsRegistry.js";

export const AGENTWATCH_OAUTH_SCOPE = "testchimp agentwatch";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

type AuthServerMetadata = {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
};

export type ConnectOptions = {
  backendUrl: string;
  ingressUrl?: string;
  /** When set, the project picked on the consent page must match. */
  expectedProjectId?: string;
  /** Loopback port for the redirect; 0 picks a free one. */
  port?: number;
  timeoutMs?: number;
  /** Opens the consent URL; default launches the system browser. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Progress lines (stderr in the CLI). */
  log?: (line: string) => void;
  env?: RegistryEnv;
};

export type ConnectResult = {
  projectId: string;
  userId: string;
  email?: string;
  botId?: string;
  credentialsPath: string;
};

/**
 * Ingress for a TestChimp SaaS backend (`featureservice[-env].testchimp.io` → `ingress[-env].testchimp.io`),
 * so stored credentials never mix deployments. Undefined for other hosts.
 */
export function ingressUrlForBackend(backendUrl: string): string | undefined {
  const url = new URL(backendUrl);
  const m = /^featureservice(-[a-z0-9-]+)?\.testchimp\.io$/i.exec(url.hostname);
  return m ? `https://ingress${m[1] ?? ""}.testchimp.io` : undefined;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail =
      stringField(body, "error_description") ??
      stringField((body.responseHeader as Record<string, unknown>) ?? {}, "errorMessage") ??
      text.slice(0, 200);
    throw new Error(`${what} failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return body;
}

async function discover(backendUrl: string): Promise<AuthServerMetadata> {
  const res = await fetch(`${backendUrl}/.well-known/oauth-authorization-server`);
  if (res.status === 404) {
    throw new Error(`OAuth is not enabled on ${backendUrl}; bot connect needs a deployment with the TestChimp OAuth server`);
  }
  // RFC 8414 metadata field names.
  const m = await readJson(res, "OAuth discovery");
  const authorizationEndpoint = stringField(m, "authorization_endpoint");
  const tokenEndpoint = stringField(m, "token_endpoint");
  const registrationEndpoint = stringField(m, "registration_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
    throw new Error("OAuth discovery returned incomplete metadata");
  }
  return {
    issuer: stringField(m, "issuer"),
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    revocationEndpoint: stringField(m, "revocation_endpoint"),
  };
}

async function registerClient(meta: AuthServerMetadata, redirectUri: string): Promise<string> {
  // RFC 7591 client metadata field names.
  const res = await fetch(meta.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "TestChimp CLI (AgentWatch)",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const clientId = stringField(await readJson(res, "OAuth client registration"), "client_id");
  if (!clientId) throw new Error("OAuth client registration returned no client_id");
  return clientId;
}

type Callback = { code: string };

function listenForCallback(
  port: number,
  state: string,
  issuer: string | undefined,
): Promise<{ server: Server; redirectUri: string; callback: Promise<Callback> }> {
  return new Promise((resolveListen, rejectListen) => {
    let settle: { resolve: (c: Callback) => void; reject: (e: Error) => void } | null = null;
    const callback = new Promise<Callback>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // The browser can answer before the caller starts awaiting (e.g. while openUrl is still running).
    callback.catch(() => undefined);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const page = (title: string, body: string) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`<!doctype html><title>${title}</title><body style="font-family:sans-serif;padding:2rem"><h2>${title}</h2><p>${body}</p></body>`);
      };
      const error = url.searchParams.get("error");
      if (url.searchParams.get("state") !== state) {
        page("TestChimp connection failed", "The response did not match this login attempt. Run testchimp bot connect again.");
        settle?.reject(new Error("OAuth state mismatch"));
        return;
      }
      const iss = url.searchParams.get("iss");
      if (issuer && iss && iss !== issuer) {
        page("TestChimp connection failed", "Unexpected authorization server.");
        settle?.reject(new Error(`OAuth issuer mismatch: ${iss}`));
        return;
      }
      if (error) {
        const denied = error === "access_denied";
        page(
          denied ? "Connection denied" : "TestChimp connection failed",
          denied ? "You can close this tab." : "You can close this tab and check the terminal.",
        );
        settle?.reject(new Error(denied ? "The user denied access" : `OAuth error: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim()));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        page("TestChimp connection failed", "No authorization code was returned.");
        settle?.reject(new Error("OAuth callback carried no code"));
        return;
      }
      page("Connected to TestChimp", "AgentWatch credentials are being saved. You can close this tab.");
      settle?.resolve({ code });
    });
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const actual = (server.address() as AddressInfo).port;
      resolveListen({ server, redirectUri: `http://127.0.0.1:${actual}/callback`, callback });
    });
  });
}

/** Best-effort system browser launch; the URL is always printed too. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* printed URL is the fallback */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s waiting for browser approval`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function connectAgentWatch(opts: ConnectOptions): Promise<ConnectResult> {
  const log = opts.log ?? (() => undefined);
  const meta = await discover(opts.backendUrl);

  const state = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const { server, redirectUri, callback } = await listenForCallback(opts.port ?? 0, state, meta.issuer);
  try {
    const clientId = await registerClient(meta, redirectUri);
    const authorize = new URL(meta.authorizationEndpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: AGENTWATCH_OAUTH_SCOPE,
    }).toString();

    log(`Open this URL to approve AgentWatch access (pick the project, tick "Use this connection as my QA bot"):`);
    log(authorize.toString());
    await (opts.openUrl ?? openInBrowser)(authorize.toString());

    const { code } = await withTimeout(callback, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // RFC 6749 token request / response field names.
    const tokenRes = await fetch(meta.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    const tokens = await readJson(tokenRes, "OAuth token exchange");
    const accessToken = stringField(tokens, "access_token");
    const refreshToken = stringField(tokens, "refresh_token");
    if (!accessToken) throw new Error("OAuth token exchange returned no access_token");

    try {
      const granted = (stringField(tokens, "scope") ?? "").split(/\s+/);
      if (!granted.includes("agentwatch")) {
        throw new Error("This deployment did not grant the agentwatch scope; upgrade TestChimp or use TestChimp Studio sign-in");
      }

      const credsRes = await fetch(`${opts.backendUrl}/bots/get_agentwatch_credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: "{}",
      });
      const creds = await readJson(credsRes, "Fetching AgentWatch credentials");
      const projectId = stringField(creds, "projectId");
      const userId = stringField(creds, "userId");
      const userAuthKey = stringField(creds, "userAuthKey");
      const projectApiKey = stringField(creds, "projectApiKey");
      if (!projectId || !userId || !userAuthKey || !projectApiKey) {
        throw new Error("AgentWatch credentials response was incomplete");
      }
      if (opts.expectedProjectId && opts.expectedProjectId !== projectId) {
        throw new Error(
          `Approved project ${projectId} does not match --project-id ${opts.expectedProjectId}; run bot connect again and pick the right project`,
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
          backendUrl: opts.backendUrl,
          ...(opts.ingressUrl ? { ingressUrl: opts.ingressUrl } : {}),
          savedAtMillis: Date.now(),
        },
        opts.env,
      );
      return { projectId, userId, ...(email ? { email } : {}), ...(botId ? { botId } : {}), credentialsPath };
    } finally {
      if (refreshToken && meta.revocationEndpoint) {
        await fetch(meta.revocationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        }).catch(() => undefined);
      }
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}
