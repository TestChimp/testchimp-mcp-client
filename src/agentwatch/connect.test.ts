import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { connectAgentWatch, ingressUrlForBackend } from "./connect.js";
import {
  agentwatchCredentialsPath,
  readAgentwatchCredentials,
  removeProjectCredentials,
  saveProjectCredentials,
} from "./credentialsFile.js";

type FakeOptions = {
  grantedScope?: string;
  deny?: boolean;
  projectId?: string;
};

type Fake = {
  url: string;
  server: Server;
  authorizeScopes: string[];
  revoked: string[];
};

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function startFakeAuthServer(opts: FakeOptions = {}): Promise<Fake> {
  const fake: Fake = { url: "", server: createServer(), authorizeScopes: [], revoked: [] };
  let challenge = "";
  let redirectUri = "";
  fake.server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", fake.url);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: fake.url,
        authorization_endpoint: `${fake.url}/oauth/authorize`,
        token_endpoint: `${fake.url}/oauth/token`,
        registration_endpoint: `${fake.url}/oauth/register`,
        revocation_endpoint: `${fake.url}/oauth/revoke`,
      });
    }
    if (url.pathname === "/oauth/register") {
      redirectUri = (JSON.parse(await body(req)) as { redirect_uris: string[] }).redirect_uris[0];
      return json(201, { client_id: "client-1" });
    }
    if (url.pathname === "/oauth/authorize") {
      fake.authorizeScopes.push(url.searchParams.get("scope") ?? "");
      challenge = url.searchParams.get("code_challenge") ?? "";
      const back = new URL(url.searchParams.get("redirect_uri") ?? redirectUri);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", fake.url);
      if (opts.deny) back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", "code-1");
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await body(req));
      const expected = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (form.get("code") !== "code-1" || expected !== challenge || form.get("redirect_uri") !== redirectUri) {
        return json(400, { error: "invalid_grant", error_description: "bad exchange" });
      }
      return json(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        scope: opts.grantedScope ?? "testchimp agentwatch",
      });
    }
    if (url.pathname === "/bots/get_agentwatch_credentials") {
      if (req.headers.authorization !== "Bearer access-1") return json(401, {});
      return json(200, {
        projectId: opts.projectId ?? "proj-1",
        userId: "user-1",
        email: "dev@example.com",
        userAuthKey: "pat-0123456789",
        projectApiKey: "key-0123456789",
        botId: "bot-1",
      });
    }
    if (url.pathname === "/oauth/revoke") {
      fake.revoked.push(new URLSearchParams(await body(req)).get("token") ?? "");
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

/** Plays the browser: follows the consent redirect back to the CLI's loopback callback. */
async function browser(url: string): Promise<void> {
  await fetch(url);
}

describe("bot connect (AgentWatch credentials)", () => {
  let home: string;
  let fake: Fake | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tc-aw-"));
  });

  afterEach(() => {
    fake?.server.close();
    fake = null;
    rmSync(home, { recursive: true, force: true });
  });

  it("requests the agentwatch scope, stores user id / PAT / API key at 0600 and revokes the refresh token", async () => {
    fake = await startFakeAuthServer();
    const result = await connectAgentWatch({
      backendUrl: fake.url,
      ingressUrl: "https://ingress.testchimp.io",
      openUrl: browser,
      env: { home },
    });
    assert.deepEqual(result, {
      projectId: "proj-1",
      userId: "user-1",
      email: "dev@example.com",
      botId: "bot-1",
      credentialsPath: agentwatchCredentialsPath({ home }),
    });
    assert.deepEqual(fake.authorizeScopes, ["testchimp agentwatch"]);
    assert.deepEqual(fake.revoked, ["refresh-1"]);

    const stored = readAgentwatchCredentials({ home })?.projects["proj-1"];
    assert.equal(stored?.userId, "user-1");
    assert.equal(stored?.userAuthKey, "pat-0123456789");
    assert.equal(stored?.projectApiKey, "key-0123456789");
    assert.equal(stored?.botId, "bot-1");
    assert.equal(stored?.backendUrl, fake.url);
    if (process.platform !== "win32") {
      assert.equal(statSync(agentwatchCredentialsPath({ home })).mode & 0o777, 0o600);
    }
  });

  it("refuses a project other than --project-id and stores nothing", async () => {
    fake = await startFakeAuthServer({ projectId: "proj-2" });
    await assert.rejects(
      connectAgentWatch({ backendUrl: fake.url, expectedProjectId: "proj-1", openUrl: browser, env: { home } }),
      /does not match --project-id proj-1/,
    );
    assert.equal(readAgentwatchCredentials({ home }), null);
    assert.deepEqual(fake.revoked, ["refresh-1"]);
  });

  it("fails clearly when the deployment does not grant the agentwatch scope", async () => {
    fake = await startFakeAuthServer({ grantedScope: "testchimp" });
    await assert.rejects(
      connectAgentWatch({ backendUrl: fake.url, openUrl: browser, env: { home } }),
      /did not grant the agentwatch scope/,
    );
    assert.equal(readAgentwatchCredentials({ home }), null);
  });

  it("reports a denied consent", async () => {
    fake = await startFakeAuthServer({ deny: true });
    await assert.rejects(
      connectAgentWatch({ backendUrl: fake.url, openUrl: browser, env: { home } }),
      /denied access/,
    );
  });

  it("derives the ingress of the same SaaS deployment", () => {
    assert.equal(ingressUrlForBackend("https://featureservice.testchimp.io"), "https://ingress.testchimp.io");
    assert.equal(
      ingressUrlForBackend("https://featureservice-staging.testchimp.io/"),
      "https://ingress-staging.testchimp.io",
    );
    assert.equal(ingressUrlForBackend("http://localhost:8080"), undefined);
  });

  it("keeps other projects when saving and removes the file with the last project", () => {
    const entry = (userId: string) => ({
      userId,
      userAuthKey: "pat-0123456789",
      projectApiKey: "key-0123456789",
      backendUrl: "https://featureservice.testchimp.io",
      savedAtMillis: 1,
    });
    saveProjectCredentials("a", entry("u1"), { home });
    saveProjectCredentials("b", entry("u2"), { home });
    assert.deepEqual(Object.keys(readAgentwatchCredentials({ home })?.projects ?? {}).sort(), ["a", "b"]);
    assert.equal(removeProjectCredentials("a", { home }), true);
    assert.equal(removeProjectCredentials("a", { home }), false);
    assert.equal(removeProjectCredentials("b", { home }), true);
    assert.equal(readAgentwatchCredentials({ home }), null);
  });
});
