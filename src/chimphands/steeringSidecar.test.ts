import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSteeringSidecarPrompt,
  extractAssistantReplyParts,
  parseOpencodeModelRef,
} from "./steeringSidecar.js";

describe("parseOpencodeModelRef", () => {
  it("splits provider/model", () => {
    assert.deepEqual(parseOpencodeModelRef("testchimp/gpt-5.6-luna"), {
      providerID: "testchimp",
      modelID: "gpt-5.6-luna",
    });
  });
});

describe("buildSteeringSidecarPrompt", () => {
  it("includes summary and user question", () => {
    const prompt = buildSteeringSidecarPrompt("why WIF?", "Prior: discussed CI auth.");
    assert.match(prompt, /why WIF\?/);
    assert.match(prompt, /Prior: discussed CI auth\./);
    assert.match(prompt, /Do NOT run bash/);
  });
});

describe("extractAssistantReplyParts", () => {
  it("returns text parts from assistant message", () => {
    const parts = extractAssistantReplyParts({
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Use WIF in CI." }],
    });
    assert.deepEqual(parts, ["Use WIF in CI."]);
  });
});
