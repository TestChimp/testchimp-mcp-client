import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertFolderMatchesRepo, inspectLocalGitRepo, normalizeGitRemoteToFullName } from "./gitRepo.js";
import {
  findWorkspaceMapping,
  ProjectsRegistrySchema,
  projectsRegistryPath,
  readProjectsRegistry,
  type RegistryEnv,
  upsertWorkspaceFolder,
} from "./projectsRegistry.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = join(repoRoot, "fixtures", "projects-registry");
const desktopFixturesDir =
  process.env.TESTCHIMP_DESKTOP_FIXTURES_DIR ??
  resolve(repoRoot, "..", "AwareRepo", "desktop", "src", "main", "workspace", "__fixtures__", "projectsRegistry");
const cliBin = join(repoRoot, "dist", "bin", "testchimp.js");

type Step = { projectId: string; projectName?: string; folder: string; reassign?: boolean; expectError?: string };
type Sequence = {
  name: string;
  initial: string | null;
  steps: Step[];
  expected: string;
  expectedCli?: string;
  expectQuarantine?: boolean;
};
type SequenceFile = {
  clock: { startMillis: number; stepMillis: number };
  idPattern: string;
  folders: string[];
  sequences: Sequence[];
};

const sequenceFile = JSON.parse(readFileSync(join(fixturesDir, "sequences.json"), "utf8")) as SequenceFile;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(relative(fixturesDir, full));
  }
  return out;
}

function withRoot(text: string, root: string): string {
  return text.split("__ROOT__").join(JSON.stringify(root).slice(1, -1));
}

function readFixture(rel: string, root: string): string {
  return withRoot(readFileSync(join(fixturesDir, rel), "utf8"), root);
}

function makeScratch(): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tc-projects-registry-")));
  const home = join(base, "home");
  const root = join(base, "work");
  mkdirSync(home);
  mkdirSync(root);
  for (const f of sequenceFile.folders) mkdirSync(join(root, f));
  return { home, root };
}

function idSource(): () => string {
  let n = 0;
  return () => sequenceFile.idPattern.replace("{n12}", String(++n).padStart(12, "0"));
}

describe("projects.json fixtures parse with the CLI schema", () => {
  const root = "/fixture-root";
  for (const rel of listFiles(join(fixturesDir, "valid")).concat(listFiles(join(fixturesDir, "edge")))) {
    it(`accepts ${rel}`, () => {
      assert.equal(ProjectsRegistrySchema.safeParse(JSON.parse(readFixture(rel, root))).success, true);
    });
  }
  for (const rel of listFiles(join(fixturesDir, "invalid"))) {
    it(`rejects ${rel}`, () => {
      assert.equal(ProjectsRegistrySchema.safeParse(JSON.parse(readFixture(rel, root))).success, false);
    });
  }
  for (const rel of listFiles(join(fixturesDir, "expected"))) {
    it(`accepts writer output ${rel} (incl. Studio's)`, () => {
      assert.equal(ProjectsRegistrySchema.safeParse(JSON.parse(readFixture(rel, root))).success, true);
    });
  }
});

describe("upsert sequences produce the contract bytes", () => {
  for (const seq of sequenceFile.sequences) {
    it(seq.name, () => {
      const { home, root } = makeScratch();
      try {
        let step = 0;
        const env: RegistryEnv = {
          home,
          newId: idSource(),
          now: () => sequenceFile.clock.startMillis + step * sequenceFile.clock.stepMillis,
        };
        const registryPath = projectsRegistryPath(env);
        let initialBytes: string | null = null;
        if (seq.initial) {
          initialBytes = readFixture(seq.initial, root);
          writeFileSync(registryPath, initialBytes);
        }
        for (; step < seq.steps.length; step++) {
          const s = seq.steps[step]!;
          const input = { projectId: s.projectId, projectName: s.projectName, rootPath: join(root, s.folder), reassign: s.reassign };
          if (s.expectError) {
            const before = readFileSync(registryPath, "utf8");
            assert.throws(() => upsertWorkspaceFolder(input, env), (e: Error) => e.message.includes(s.expectError!));
            assert.equal(readFileSync(registryPath, "utf8"), before);
          } else {
            upsertWorkspaceFolder(input, env);
          }
        }
        const actual = readFileSync(registryPath, "utf8");
        const expectedRel = seq.expectedCli ?? seq.expected;
        if (process.env.UPDATE_PROJECTS_REGISTRY_FIXTURES === "1") {
          writeFileSync(join(fixturesDir, expectedRel), actual.split(JSON.stringify(root).slice(1, -1)).join("__ROOT__"));
        }
        assert.equal(actual, readFixture(expectedRel, root));
        assert.equal(statSync(registryPath).mode & 0o777, 0o600);
        const quarantined = readdirSync(home).filter((f) => /^projects\.invalid\.\d+\.json$/.test(f));
        if (seq.expectQuarantine) {
          assert.equal(quarantined.length, 1);
          assert.equal(readFileSync(join(home, quarantined[0]!), "utf8"), initialBytes);
        } else {
          assert.deepEqual(quarantined, []);
        }
      } finally {
        rmSync(dirname(home), { recursive: true, force: true });
      }
    });
  }
});

describe("fixture copy in TestChimp Studio (desktop) is byte-identical", () => {
  it("matches every file", { skip: existsSync(desktopFixturesDir) ? false : `no desktop checkout at ${desktopFixturesDir}` }, () => {
    const ours = listFiles(fixturesDir).sort();
    const theirs = (function walk(dir: string): string[] {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else out.push(relative(desktopFixturesDir, full));
      }
      return out;
    })(desktopFixturesDir).sort();
    assert.deepEqual(theirs, ours);
    for (const rel of ours) {
      assert.equal(readFileSync(join(desktopFixturesDir, rel), "utf8"), readFileSync(join(fixturesDir, rel), "utf8"), rel);
    }
  });
});

describe("registry read edge cases", () => {
  let scratch: { home: string; root: string };
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => {
    rmSync(dirname(scratch.home), { recursive: true, force: true });
  });

  it("quarantines an unparseable file instead of discarding it", () => {
    const env: RegistryEnv = { home: scratch.home, now: () => 42 };
    writeFileSync(projectsRegistryPath(env), "{not json");
    assert.deepEqual(readProjectsRegistry(env).mappings, []);
    assert.equal(readFileSync(join(scratch.home, "projects.invalid.42.json"), "utf8"), "{not json");
  });

  it("findWorkspaceMapping is read-only", () => {
    const env: RegistryEnv = { home: scratch.home };
    assert.equal(findWorkspaceMapping("p1", env), null);
    assert.equal(existsSync(projectsRegistryPath(env)), false);
    writeFileSync(projectsRegistryPath(env), "{not json");
    assert.throws(() => findWorkspaceMapping("p1", env), /INVALID_REGISTRY/);
    assert.equal(readFileSync(projectsRegistryPath(env), "utf8"), "{not json");
  });

  it("honours TESTCHIMP_HOME", () => {
    const prev = process.env.TESTCHIMP_HOME;
    process.env.TESTCHIMP_HOME = scratch.home;
    try {
      upsertWorkspaceFolder({ projectId: "p1", rootPath: join(scratch.root, "repo-a") });
      assert.equal(findWorkspaceMapping("p1")?.folders[0]?.path, join(scratch.root, "repo-a"));
    } finally {
      if (prev === undefined) delete process.env.TESTCHIMP_HOME;
      else process.env.TESTCHIMP_HOME = prev;
    }
  });

  it("rejects a missing folder", () => {
    assert.throws(
      () => upsertWorkspaceFolder({ projectId: "p1", rootPath: join(scratch.root, "nope") }, { home: scratch.home }),
      /NOT_FOUND/,
    );
  });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

describe("git validation", () => {
  let scratch: { home: string; root: string };
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => {
    rmSync(dirname(scratch.home), { recursive: true, force: true });
  });

  it("normalizes remotes like Studio", () => {
    assert.equal(normalizeGitRemoteToFullName("git@github.com:Acme/Shop.git"), "Acme/Shop");
    assert.equal(normalizeGitRemoteToFullName("https://github.com/Acme/Shop.git"), "Acme/Shop");
    assert.equal(normalizeGitRemoteToFullName("ssh://git@gitlab.com/group/sub/repo"), "group/sub/repo");
  });

  it("rejects non-git folders, sub-folders and mismatched remotes", () => {
    const repo = join(scratch.root, "repo-a");
    assert.throws(() => assertFolderMatchesRepo(inspectLocalGitRepo(repo), null), /NOT_A_GIT_REPO/);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "git@github.com:acme/shop.git");
    assertFolderMatchesRepo(inspectLocalGitRepo(repo), null);
    assertFolderMatchesRepo(inspectLocalGitRepo(repo), "Acme/Shop");
    assert.throws(() => assertFolderMatchesRepo(inspectLocalGitRepo(repo), "acme/other"), /REPO_MISMATCH/);
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    assert.throws(() => assertFolderMatchesRepo(inspectLocalGitRepo(sub), "acme/shop"), /NOT_REPO_ROOT/);
  });
});

describe("testchimp workspace map|get (CLI)", () => {
  let scratch: { home: string; root: string };
  beforeEach(() => {
    scratch = makeScratch();
  });
  afterEach(() => {
    rmSync(dirname(scratch.home), { recursive: true, force: true });
  });

  function cli(...args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, TESTCHIMP_HOME: scratch.home };
    delete env.TESTCHIMP_API_KEY;
    delete env.TESTCHIMP_OAUTH_TOKEN;
    return spawnSync(process.execPath, [cliBin, ...args], { env, encoding: "utf8" });
  }

  it("maps a git repo, prints it, and enforces the conflict rule", () => {
    const repo = join(scratch.root, "repo-a");
    git(repo, "init", "-q");

    const unmapped = cli("workspace", "get", "--project-id", "p1");
    assert.equal(unmapped.status, 1);

    const mapped = cli("workspace", "map", "--project-id", "p1", "--folder", repo, "--project-name", "One");
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.match(mapped.stderr, /skipping connected-repository check/);
    const mapping = JSON.parse(mapped.stdout) as { projectId: string; projectName: string; folders: Array<{ path: string }> };
    assert.equal(mapping.projectId, "p1");
    assert.equal(mapping.projectName, "One");
    assert.equal(mapping.folders[0]?.path, repo);
    assert.equal(statSync(join(scratch.home, "projects.json")).mode & 0o777, 0o600);

    const got = cli("workspace", "get", "--project-id", "p1");
    assert.equal(got.status, 0, got.stderr);
    assert.deepEqual(JSON.parse(got.stdout), mapping);

    const conflict = cli("workspace", "map", "--project-id", "p2", "--folder", repo);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /already mapped to project p1/);

    const reassigned = cli("workspace", "map", "--project-id", "p2", "--folder", repo, "--reassign");
    assert.equal(reassigned.status, 0, reassigned.stderr);
    assert.equal(cli("workspace", "get", "--project-id", "p1").status, 1);
  });

  it("refuses a folder that is not a git repo", () => {
    const r = cli("workspace", "map", "--project-id", "p1", "--folder", join(scratch.root, "repo-b"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NOT_A_GIT_REPO/);
    assert.equal(existsSync(join(scratch.home, "projects.json")), false);
  });
});
