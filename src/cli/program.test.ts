import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACKAGE_VERSION, buildCliProgram } from "./program.js";
import {
  RELEASE_LABEL_COMMANDS,
  STRAY_RELEASE_VERSION_FLAG_MESSAGE,
  cliReleaseLabel,
  cliReleaseVersionField,
  strayReleaseVersionError,
} from "./releaseFlag.js";

function argv(...args: string[]): string[] {
  return ["node", "testchimp", ...args];
}

function releaseCommand(program: ReturnType<typeof buildCliProgram>, name: string) {
  const cmd = program.commands.find((c) => c.name() === name || c.aliases().includes(name));
  assert.ok(cmd, `missing CLI command ${name}`);
  return cmd;
}

function optionFlags(program: ReturnType<typeof buildCliProgram>, name: string): string[] {
  return releaseCommand(program, name).options.map((o) => o.flags);
}

describe("CLI release version flags", () => {
  it("maps --release / --release-version to the MCP version field", () => {
    assert.deepEqual(cliReleaseVersionField({ release: "1.2.0" }), { version: "1.2.0" });
    assert.deepEqual(cliReleaseVersionField({ releaseVersion: "1.2.0" }), { version: "1.2.0" });
    assert.deepEqual(cliReleaseVersionField({ release: " 1.2.0 ", releaseVersion: "ignored" }), {
      version: "1.2.0",
    });
    assert.deepEqual(cliReleaseVersionField({}), {});
    assert.equal(cliReleaseLabel({ releaseVersion: "sprint-12" }), "sprint-12");
  });

  it("rejects a valued --version on every release command", () => {
    for (const command of RELEASE_LABEL_COMMANDS) {
      assert.equal(
        strayReleaseVersionError(argv(command, "--version", "1.2.0")),
        STRAY_RELEASE_VERSION_FLAG_MESSAGE,
        command,
      );
      assert.equal(
        strayReleaseVersionError(argv(command, "--version=1.2.0")),
        STRAY_RELEASE_VERSION_FLAG_MESSAGE,
        `${command} equals`,
      );
    }
  });

  it("does not treat a bare --version or a non-release command as a stray flag", () => {
    assert.equal(strayReleaseVersionError(argv("--version")), undefined);
    assert.equal(strayReleaseVersionError(argv("-V")), undefined);
    assert.equal(strayReleaseVersionError(argv("get-release", "--version")), undefined);
    assert.equal(strayReleaseVersionError(argv("get-org-capabilities", "--version", "1.2.0")), undefined);
    assert.equal(strayReleaseVersionError(argv("get-release", "--release", "1.2.0")), undefined);
  });

  it("does not register --version as a release-label option", () => {
    const program = buildCliProgram();
    for (const name of ["get-release", "upsert-release", "manage-test-run", "get-release-details"]) {
      const flags = optionFlags(program, name);
      assert.ok(flags.some((f) => f.includes("--release <")), name);
      assert.ok(flags.some((f) => f.includes("--release-version")), name);
      assert.ok(
        !flags.some((f) => /(^|[\s,])--version(\s|=|$)/.test(f)),
        `${name} must not take --version as a release flag`,
      );
    }
  });

  it("parses --release and --release-version on get-release / upsert-release", async () => {
    for (const [command, flag] of [
      ["get-release", "--release"],
      ["get-release", "--release-version"],
      ["get-release-details", "--release"],
      ["upsert-release", "--release"],
      ["manage-test-run", "--release-version"],
    ] as const) {
      const program = buildCliProgram();
      program.exitOverride();
      let captured: { release?: unknown; releaseVersion?: unknown } | undefined;
      program.hook("preAction", (_thisCommand, actionCommand) => {
        captured = actionCommand.opts();
        throw new Error("stop-before-api");
      });
      await assert.rejects(
        () => program.parseAsync(argv(command, flag, "1.2.0")),
        /stop-before-api/,
      );
      assert.equal(cliReleaseLabel(captured ?? {}), "1.2.0", `${command} ${flag}`);
      if (command === "upsert-release" || command === "get-release" || command === "get-release-details") {
        assert.deepEqual(cliReleaseVersionField(captured ?? {}), { version: "1.2.0" }, `${command} MCP version`);
      }
    }
  });

  it("errors on get-release --version 1.2.0 instead of printing the CLI version", async () => {
    const program = buildCliProgram();
    program.exitOverride();
    await assert.rejects(
      () => program.parseAsync(argv("get-release", "--version", "1.2.0")),
      (err: unknown) =>
        err instanceof Error &&
        err.message === STRAY_RELEASE_VERSION_FLAG_MESSAGE &&
        (err as { code?: string }).code !== "commander.version",
    );
    await assert.rejects(
      () => program.parseAsync(argv("upsert-release", "--version=9.9.9")),
      (err: unknown) => err instanceof Error && err.message === STRAY_RELEASE_VERSION_FLAG_MESSAGE,
    );
    await assert.rejects(
      () => program.parseAsync(argv("manage-test-run", "--version", "1.2.0")),
      (err: unknown) => err instanceof Error && err.message === STRAY_RELEASE_VERSION_FLAG_MESSAGE,
    );
    await assert.rejects(
      () => program.parseAsync(argv("get-release-details", "--version", "1.2.0")),
      (err: unknown) => err instanceof Error && err.message === STRAY_RELEASE_VERSION_FLAG_MESSAGE,
    );
  });

  it("keeps --version / -V as the CLI version flag", async () => {
    for (const flag of ["--version", "-V"] as const) {
      const program = buildCliProgram();
      program.exitOverride();
      await assert.rejects(
        () => program.parseAsync(argv(flag)),
        (err: unknown) => {
          const e = err as { code?: string; message?: string };
          return e.code === "commander.version" && e.message === PACKAGE_VERSION;
        },
      );
    }
  });
});
