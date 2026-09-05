import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commitCandidatePathsFromPorcelain,
  isChimpHandsInternalCommitPath,
  pathsFromGitPorcelain,
  resolveCommitPaths,
} from "./worktreeCommitPaths.js";

describe("worktreeCommitPaths", () => {
  it("parses porcelain paths and rename destinations", () => {
    assert.deepEqual(
      pathsFromGitPorcelain(
        [" M ui/plans/foo.md", "?? chimphands-run.log", "R  old.md -> new.md"].join("\n"),
      ),
      ["ui/plans/foo.md", "chimphands-run.log", "new.md"],
    );
  });

  it("allowlists only product paths for commit", () => {
    assert.deepEqual(
      commitCandidatePathsFromPorcelain(
        [
          " M ui/plans/stories/x.md",
          "?? chimphands-run.log",
          "?? opencode-server.log",
          "?? opencode.json",
          " M src/app.ts",
          "?? .agents/skills/testchimp/SKILL.md",
        ].join("\n"),
      ),
      ["ui/plans/stories/x.md", "src/app.ts"],
    );
  });

  it("can narrow commit to an explicit path set", () => {
    const porcelain = [" M ui/plans/a.md", " M src/app.ts"].join("\n");
    assert.deepEqual(resolveCommitPaths(porcelain, ["ui/plans/a.md"]), ["ui/plans/a.md"]);
    assert.deepEqual(resolveCommitPaths(porcelain), ["ui/plans/a.md", "src/app.ts"]);
  });

  it("recognizes internal commit paths", () => {
    assert.equal(isChimpHandsInternalCommitPath("chimphands-run.log"), true);
    assert.equal(isChimpHandsInternalCommitPath(".chimphands/tmp"), true);
    assert.equal(isChimpHandsInternalCommitPath("ui/plans/x.md"), false);
  });
});
