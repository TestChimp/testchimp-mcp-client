import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyBotBinding, botBindingPath, readBotBinding, removeBotBinding, saveBotBinding } from "./bindingFile.js";

const originalEnv = { ...process.env };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-bots-"));
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(home, { recursive: true, force: true });
});

describe("bot binding file", () => {
  it("saves per bot with owner-only permissions and reads it back", () => {
    const path = saveBotBinding(
      { botId: "01BOTA", projectId: "proj-a", projectName: "A", projectApiKey: "key-aaaaaaaa", savedAtMillis: 1 },
      { home },
    );
    assert.equal(path, join(home, "bots", "01BOTA.json"));
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(home, "bots")).mode & 0o777, 0o700);
    }
    assert.equal(readBotBinding("01BOTA", { home })?.projectId, "proj-a");
    assert.equal(readBotBinding("01BOTB", { home }), null);
  });

  it("rejects bot ids that could escape the directory", () => {
    assert.throws(() => botBindingPath("../x", { home }));
    assert.throws(() => botBindingPath("a/b", { home }));
  });

  it("applying a binding overrides another bot's leftover env", () => {
    saveBotBinding(
      {
        botId: "01BOTB",
        projectId: "proj-b",
        projectApiKey: "key-bbbbbbbb",
        backendUrl: "https://featureservice-staging.testchimp.io",
        savedAtMillis: 1,
      },
      { home },
    );
    process.env.TESTCHIMP_API_KEY = "key-of-bot-a";
    process.env.TESTCHIMP_BOT_ID = "01BOTA";
    process.env.TESTCHIMP_OAUTH_TOKEN = "token";

    applyBotBinding("01BOTB", { home });

    assert.equal(process.env.TESTCHIMP_API_KEY, "key-bbbbbbbb");
    assert.equal(process.env.TESTCHIMP_BOT_ID, "01BOTB");
    assert.equal(process.env.TESTCHIMP_OAUTH_TOKEN, undefined);
    assert.equal(process.env.TESTCHIMP_BACKEND_URL, "https://featureservice-staging.testchimp.io");
  });

  it("fails clearly when the bot has no binding here, and removes bindings", () => {
    assert.throws(() => applyBotBinding("01BOTC", { home }), /No TestChimp binding for bot 01BOTC/);
    saveBotBinding({ botId: "01BOTC", projectId: "p", projectApiKey: "key-cccccccc", savedAtMillis: 1 }, { home });
    assert.equal(removeBotBinding("01BOTC", { home }), true);
    assert.equal(removeBotBinding("01BOTC", { home }), false);
  });
});
