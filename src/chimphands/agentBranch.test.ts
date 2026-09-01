import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAgentBranchName,
  isAgentBranchName,
  parseBaseBranchFromPrompt,
  resolveSessionBaseBranch,
} from "./agentBranch.js";

describe("agentBranch", () => {
  it("isAgentBranchName accepts testchimp- only", () => {
    assert.equal(isAgentBranchName("testchimp-foo"), true);
    assert.equal(isAgentBranchName("chimphands-foo"), false);
    assert.equal(isAgentBranchName("feature/foo"), false);
  });

  it("parseBaseBranchFromPrompt reads Base and legacy Working lines", () => {
    assert.equal(parseBaseBranchFromPrompt("run qa\nBase branch: dashboard"), "dashboard");
    assert.equal(parseBaseBranchFromPrompt("Working branch: main"), "main");
    assert.equal(parseBaseBranchFromPrompt("run qa only"), undefined);
  });

  it("resolveSessionBaseBranch prefers prompt over env", () => {
    assert.equal(resolveSessionBaseBranch("Base branch: a", "b"), "a");
    assert.equal(resolveSessionBaseBranch(undefined, "b"), "b");
  });

  it("buildAgentBranchName uses testchimp prefix", () => {
    assert.match(buildAgentBranchName("01ARZ3NDEKTSV4RRFFQ69G5FAV"), /^testchimp-chimphands-/);
  });
});
