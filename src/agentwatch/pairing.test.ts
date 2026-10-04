import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readAgentwatchCredentials } from "./credentialsFile.js";
import { finishAgentWatchPairing, pairingCodeFor, pendingPairingPath, startAgentWatchPairing } from "./pairing.js";

type FakeBackend = { url: string; server: Server; approve: (code: string) => void; redeemCalls: number };

async function startFakeBackend(projectId = "proj-1"): Promise<FakeBackend> {
  const approved = new Set<string>();
  const redeemed = new Set<string>();
  const fake: FakeBackend = {
    url: "",
    server: createServer(),
    approve: (code) => approved.add(code),
    redeemCalls: 0,
  };
  fake.server.on("request", (req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url !== "/bots/redeem_agentwatch_pairing") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      fake.redeemCalls++;
      const code = pairingCodeFor((JSON.parse(data) as { codeVerifier: string }).codeVerifier);
      if (!approved.has(code) || redeemed.has(code)) {
        res.end(JSON.stringify({ pending: true }));
        return;
      }
      redeemed.add(code);
      res.end(
        JSON.stringify({
          credentials: {
            projectId,
            userId: "user-1",
            email: "a@b.c",
            userAuthKey: "pat-123456789",
            projectApiKey: "key-123456789",
            botId: "bot-1",
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

describe("AgentWatch pairing", () => {
  let home: string;
  let fake: FakeBackend;
  let env: { home: string };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "aw-pair-"));
    env = { home };
    fake = await startFakeBackend();
  });

  afterEach(() => {
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("stores credentials once the bot approves, and keeps the verifier private", async () => {
    const started = startAgentWatchPairing({ backendUrl: fake.url, expectedProjectId: "proj-1", env });
    assert.match(started.pairingCode, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(pendingPairingPath(env)).mode & 0o777, 0o600);
    }

    await assert.rejects(
      finishAgentWatchPairing({ backendUrl: fake.url, timeoutMs: 50, pollIntervalMs: 10, env }),
      /has not been approved yet/,
    );

    fake.approve(started.pairingCode);
    const result = await finishAgentWatchPairing({ backendUrl: fake.url, timeoutMs: 1000, pollIntervalMs: 10, env });
    assert.deepEqual(
      { projectId: result.projectId, userId: result.userId, botId: result.botId },
      { projectId: "proj-1", userId: "user-1", botId: "bot-1" },
    );
    const stored = readAgentwatchCredentials(env)!.projects["proj-1"];
    assert.equal(stored.userAuthKey, "pat-123456789");
    assert.equal(stored.backendUrl, fake.url);
    assert.equal(existsSync(pendingPairingPath(env)), false);

    await assert.rejects(finishAgentWatchPairing({ backendUrl: fake.url, env }), /No pending AgentWatch pairing/);
  });

  it("stores nothing when the bot approved another project", async () => {
    const started = startAgentWatchPairing({ backendUrl: fake.url, expectedProjectId: "proj-2", env });
    fake.approve(started.pairingCode);
    await assert.rejects(
      finishAgentWatchPairing({ backendUrl: fake.url, timeoutMs: 1000, pollIntervalMs: 10, env }),
      /approved project proj-1, not proj-2/,
    );
    assert.equal(readAgentwatchCredentials(env), null);
  });

  it("refuses to finish against a different backend", async () => {
    startAgentWatchPairing({ backendUrl: fake.url, env });
    await assert.rejects(
      finishAgentWatchPairing({ backendUrl: "https://featureservice.testchimp.io", env }),
      /was started against/,
    );
    assert.equal(fake.redeemCalls, 0);
  });
});
