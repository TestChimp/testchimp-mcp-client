import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type OpencodeSessionMessage,
  userMessageHasAssistantReply,
} from "./midTurnSteering.js";

function userMsg(text: string): OpencodeSessionMessage {
  return { info: { role: "user" }, parts: [{ type: "text", text }] };
}

function assistantText(text: string): OpencodeSessionMessage {
  return { info: { role: "assistant" }, parts: [{ type: "text", text }] };
}

function assistantTool(status: string): OpencodeSessionMessage {
  return {
    info: { role: "assistant" },
    parts: [{ type: "tool", state: { status } }],
  };
}

describe("userMessageHasAssistantReply", () => {
  it("returns false when user message has no assistant reply after it", () => {
    const messages = [userMsg("why gcp_sa_json_path?")];
    assert.equal(userMessageHasAssistantReply(messages, "why gcp_sa_json_path?"), false);
  });

  it("returns true when assistant text follows the matching user message", () => {
    const messages = [
      userMsg("first question"),
      assistantText("first answer"),
      userMsg("why gcp_sa_json_path?"),
      assistantText("We should use WIF in CI."),
    ];
    assert.equal(userMessageHasAssistantReply(messages, "why gcp_sa_json_path?"), true);
  });

  it("matches the latest user message with the same content", () => {
    const messages = [
      userMsg("repeat"),
      assistantText("old answer"),
      userMsg("repeat"),
    ];
    assert.equal(userMessageHasAssistantReply(messages, "repeat"), false);
  });

  it("counts completed tool output as a reply", () => {
    const messages = [userMsg("check auth"), assistantTool("completed")];
    assert.equal(userMessageHasAssistantReply(messages, "check auth"), true);
  });

  it("ignores pending tool parts as a reply", () => {
    const messages = [userMsg("run tests"), assistantTool("running")];
    assert.equal(userMessageHasAssistantReply(messages, "run tests"), false);
  });
});
