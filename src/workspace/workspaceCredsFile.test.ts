import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyWorkspaceCredsFallback,
  ensureGitignoreHasTestchimp,
  findWorkspaceCredsEnv,
  planWorkspaceCreds,
  workspaceMcpJsonPath,
  writePlannedWorkspaceCreds,
} from "./workspaceCredsFile.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = join(repoRoot, "fixtures", "workspace-mcp-json");
const desktopFixturesDir =
  process.env.TESTCHIMP_DESKTOP_WORKSPACE_MCP_FIXTURES_DIR ??
  resolve(repoRoot, "..", "AwareRepo", "desktop", "src", "main", "workspace", "__fixtures__", "workspaceMcpJson");
const cliBin = join(repoRoot, "dist", "bin", "testchimp.js");

const KEY = "fake-project-key-0001";
const PROJECT = "proj-fixture-1";
const PROD = { apiKey: KEY, projectId: PROJECT, backendUrl: "https://featureservice.testchimp.io", ingressUrl: "https://ingress.testchimp.io" };
const STAGING = {
  apiKey: KEY,
  projectId: PROJECT,
  backendUrl: "https://featureservice-staging.testchimp.io/",
  ingressUrl: "https://ingress-staging.testchimp.io",
};

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tc-wscreds-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function save(input: typeof PROD, opts: { reassign?: boolean } = {}) {
  return writePlannedWorkspaceCreds(planWorkspaceCreds(root, input, opts));
}

describe("workspace creds file (Studio format)", () => {
  it("writes the fixture bytes for prod and staging, 0600 in a 0700 dir", () => {
    const r = save(PROD);
    assert.equal(r.status, "written");
    assert.equal(r.mcpJsonPath, workspaceMcpJsonPath(root));
    assert.equal(readFileSync(r.mcpJsonPath, "utf8"), fixture("expected-fresh-prod.json"));
    assert.equal(statSync(r.mcpJsonPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(r.mcpJsonPath)).mode & 0o777, 0o700);

    rmSync(join(root, ".testchimp"), { recursive: true });
    save(STAGING);
    assert.equal(readFileSync(workspaceMcpJsonPath(root), "utf8"), fixture("expected-fresh-staging.json"));
  });

  it("keeps other servers already in the file", () => {
    mkdirSync(join(root, ".testchimp"));
    writeFileSync(workspaceMcpJsonPath(root), fixture("existing-other-servers.json"));
    assert.equal(save(PROD).status, "written");
    assert.equal(readFileSync(workspaceMcpJsonPath(root), "utf8"), fixture("expected-merged-prod.json"));
  });

  it("leaves a same-project entry alone, refreshing only a changed key", () => {
    mkdirSync(join(root, ".testchimp"));
    const studio = {
      schemaVersion: 1,
      mcpServers: {
        testchimp: {
          command: "/Users/x/.testchimp/npm/bin/testchimp",
          args: ["mcp"],
          env: { TESTCHIMP_API_KEY: KEY, TESTCHIMP_PROJECT_ID: PROJECT, TESTCHIMP_USER_ID: "u1" },
          enabled: true,
        },
      },
    };
    const studioBytes = `${JSON.stringify(studio, null, 2)}\n`;
    writeFileSync(workspaceMcpJsonPath(root), studioBytes);
    assert.equal(save(PROD).status, "unchanged");
    assert.equal(readFileSync(workspaceMcpJsonPath(root), "utf8"), studioBytes);

    assert.equal(save({ ...PROD, apiKey: "fake-rotated-key" }).status, "updated");
    const after = JSON.parse(readFileSync(workspaceMcpJsonPath(root), "utf8"));
    assert.equal(after.mcpServers.testchimp.command, "/Users/x/.testchimp/npm/bin/testchimp");
    assert.equal(after.mcpServers.testchimp.env.TESTCHIMP_API_KEY, "fake-rotated-key");
    assert.equal(after.mcpServers.testchimp.env.TESTCHIMP_USER_ID, "u1");
  });

  it("refuses another project's entry unless reassign", () => {
    save(PROD);
    assert.throws(() => save({ ...PROD, projectId: "proj-other", apiKey: "fake-other" }), /--reassign/);
    assert.equal(readFileSync(workspaceMcpJsonPath(root), "utf8"), fixture("expected-fresh-prod.json"));
    assert.equal(save({ ...PROD, projectId: "proj-other", apiKey: "fake-other" }, { reassign: true }).status, "updated");
    assert.equal(JSON.parse(readFileSync(workspaceMcpJsonPath(root), "utf8")).mcpServers.testchimp.env.TESTCHIMP_PROJECT_ID, "proj-other");
  });

  it("does not clobber an unparseable file", () => {
    mkdirSync(join(root, ".testchimp"));
    writeFileSync(workspaceMcpJsonPath(root), "{ not json");
    assert.throws(() => save(PROD), /INVALID_MCP_JSON/);
    assert.equal(readFileSync(workspaceMcpJsonPath(root), "utf8"), "{ not json");
  });

  it("adds .testchimp/ to .gitignore the way Studio does", () => {
    assert.equal(save(PROD).gitignoreUpdated, true);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), ".testchimp/\n");
    assert.equal(ensureGitignoreHasTestchimp(root), false);

    writeFileSync(join(root, ".gitignore"), "node_modules");
    assert.equal(ensureGitignoreHasTestchimp(root), true);
    assert.equal(
      readFileSync(join(root, ".gitignore"), "utf8"),
      "node_modules\n\n# TestChimp Studio local project config (credentials)\n.testchimp/\n",
    );
    writeFileSync(join(root, ".gitignore"), "/.testchimp\n");
    assert.equal(ensureGitignoreHasTestchimp(root), false);
  });
});

describe("workspace creds fallback for the CLI", () => {
  it("finds the nearest file with a real key and fills only unset env", () => {
    save(STAGING);
    const nested = join(root, "tests", "e2e");
    mkdirSync(nested, { recursive: true });
    assert.deepEqual(findWorkspaceCredsEnv(nested)?.env, {
      TESTCHIMP_API_KEY: KEY,
      TESTCHIMP_PROJECT_ID: PROJECT,
      TESTCHIMP_BACKEND_URL: "https://featureservice-staging.testchimp.io",
      TESTCHIMP_INGRESS_URL: "https://ingress-staging.testchimp.io",
    });

    const env: NodeJS.ProcessEnv = { TESTCHIMP_INGRESS_URL: "https://ingress.example.com" };
    assert.equal(applyWorkspaceCredsFallback(env, nested), workspaceMcpJsonPath(root));
    assert.equal(env.TESTCHIMP_API_KEY, KEY);
    assert.equal(env.TESTCHIMP_INGRESS_URL, "https://ingress.example.com");
  });

  it("never applies when a key or OAuth token is exported", () => {
    save(PROD);
    const withKey: NodeJS.ProcessEnv = { TESTCHIMP_API_KEY: "fake-env-key" };
    assert.equal(applyWorkspaceCredsFallback(withKey, root), null);
    assert.equal(withKey.TESTCHIMP_API_KEY, "fake-env-key");
    const withToken: NodeJS.ProcessEnv = { TESTCHIMP_OAUTH_TOKEN: "jwt" };
    assert.equal(applyWorkspaceCredsFallback(withToken, root), null);
    assert.equal(withToken.TESTCHIMP_API_KEY, undefined);
  });

  it("skips placeholder keys", () => {
    mkdirSync(join(root, ".testchimp"));
    writeFileSync(
      workspaceMcpJsonPath(root),
      JSON.stringify({ mcpServers: { testchimp: { env: { TESTCHIMP_API_KEY: "${TESTCHIMP_API_KEY}" } } } }),
    );
    assert.equal(findWorkspaceCredsEnv(root), null);
    writeFileSync(
      workspaceMcpJsonPath(root),
      JSON.stringify({ mcpServers: { testchimp: { env: { TESTCHIMP_API_KEY: "paste_your_key_here" } } } }),
    );
    assert.equal(findWorkspaceCredsEnv(root), null);
  });

  it("ignores a file other users can read (e.g. committed to a cloned repo)", { skip: process.platform === "win32" }, () => {
    save(PROD);
    chmodSync(workspaceMcpJsonPath(root), 0o644);
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    assert.equal(applyWorkspaceCredsFallback(env, root, (m) => warnings.push(m)), null);
    assert.equal(env.TESTCHIMP_API_KEY, undefined);
    assert.match(warnings[0] ?? "", /chmod 600/);
    assert.ok(!warnings.join("").includes(KEY));
  });

  it("warns when an exported backend differs from the file's", () => {
    save(PROD);
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = { TESTCHIMP_BACKEND_URL: "https://featureservice-staging.testchimp.io/" };
    assert.equal(applyWorkspaceCredsFallback(env, root, (m) => warnings.push(m)), workspaceMcpJsonPath(root));
    assert.equal(env.TESTCHIMP_BACKEND_URL, "https://featureservice-staging.testchimp.io/");
    assert.match(warnings[0] ?? "", /differs/);

    const quiet: string[] = [];
    applyWorkspaceCredsFallback({ TESTCHIMP_BACKEND_URL: "https://featureservice.testchimp.io" }, root, (m) => quiet.push(m));
    assert.deepEqual(quiet, []);
  });

  it("rejects malformed project ids and multi-token keys before touching disk", () => {
    assert.throws(() => save({ ...PROD, projectId: "../etc" }), /--project-id/);
    assert.throws(() => save({ ...PROD, apiKey: "fake key" }), /single token/);
    assert.equal(existsSync(join(root, ".testchimp")), false);
  });
});

describe("testchimp workspace save-creds (CLI)", () => {
  function run(args: string[], input: string, home: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, TESTCHIMP_HOME: home };
    delete env.TESTCHIMP_API_KEY;
    delete env.TESTCHIMP_OAUTH_TOKEN;
    delete env.TESTCHIMP_BACKEND_URL;
    delete env.TESTCHIMP_INGRESS_URL;
    return spawnSync(process.execPath, [cliBin, "workspace", "save-creds", ...args], { env, input, encoding: "utf8" });
  }

  it("writes the file from stdin, maps the folder, and never prints the key", () => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const r = run(["--folder", repo, "--project-id", PROJECT, "--project-name", "Shop"], `${KEY}\n`, home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "written");
    assert.equal(out.projectId, PROJECT);
    assert.equal(readFileSync(workspaceMcpJsonPath(repo), "utf8"), fixture("expected-fresh-prod.json"));
    const registry = JSON.parse(readFileSync(join(home, "projects.json"), "utf8"));
    assert.equal(registry.mappings[0].projectId, PROJECT);
    assert.equal(registry.mappings[0].folders[0].path, repo);

    const again = run(["--folder", repo, "--project-id", PROJECT], KEY, home);
    assert.equal(JSON.parse(again.stdout).status, "unchanged");
  });

  it("requires the key on stdin and refuses another project without --reassign", () => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const empty = run(["--folder", repo, "--project-id", PROJECT], "", home);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /stdin/);
    assert.equal(existsSync(workspaceMcpJsonPath(repo)), false);

    assert.equal(run(["--folder", repo, "--project-id", PROJECT], KEY, home).status, 0);
    const other = run(["--folder", repo, "--project-id", "proj-other"], "fake-other", home);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /--reassign/);
    const moved = run(["--folder", repo, "--project-id", "proj-other", "--reassign"], "fake-other", home);
    assert.equal(moved.status, 0, moved.stderr);
  });

  it("uses --backend-url / --ingress-url for staging", () => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const r = run(
      [
        "--folder", repo, "--project-id", PROJECT,
        "--backend-url", "https://featureservice-staging.testchimp.io",
        "--ingress-url", "https://ingress-staging.testchimp.io",
      ],
      KEY,
      home,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(workspaceMcpJsonPath(repo), "utf8"), fixture("expected-fresh-staging.json"));
  });

  it("derives the ingress from --backend-url rather than an exported ingress", () => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const env: NodeJS.ProcessEnv = { ...process.env, TESTCHIMP_HOME: home, TESTCHIMP_INGRESS_URL: "https://ingress.testchimp.io" };
    delete env.TESTCHIMP_API_KEY;
    delete env.TESTCHIMP_OAUTH_TOKEN;
    delete env.TESTCHIMP_BACKEND_URL;
    const r = spawnSync(
      process.execPath,
      [cliBin, "workspace", "save-creds", "--folder", repo, "--project-id", PROJECT, "--backend-url", "https://featureservice-staging.testchimp.io"],
      { env, input: KEY, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(workspaceMcpJsonPath(repo), "utf8"), fixture("expected-fresh-staging.json"));
  });
});

describe("CLI key fallback end to end", () => {
  async function runIn(cwd: string, extraEnv: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, TESTCHIMP_HOME: join(root, "home"), ...extraEnv };
    for (const k of ["TESTCHIMP_API_KEY", "TESTCHIMP_OAUTH_TOKEN", "TESTCHIMP_BOT_ID", "TESTCHIMP_BACKEND_URL", "TESTCHIMP_INGRESS_URL"]) {
      if (!(k in extraEnv)) delete env[k];
    }
    const { spawn } = await import("node:child_process");
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, [cliBin, "get-org-capabilities"], { cwd, env });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
  }

  it("uses the nearest .testchimp/mcp.json only when no key is exported", async () => {
    const { createServer } = await import("node:http");
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers["testchimp-api-key"] as string | undefined);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      save({ ...PROD, backendUrl: `http://127.0.0.1:${port}` });
      const nested = join(root, "tests");
      mkdirSync(nested);

      const viaFile = await runIn(nested, {});
      assert.equal(viaFile.code, 0, viaFile.stderr);
      assert.match(viaFile.stderr, /Using the project API key from/);
      assert.ok(!viaFile.stderr.includes(KEY));

      const viaEnv = await runIn(nested, { TESTCHIMP_API_KEY: "fake-env-key", TESTCHIMP_BACKEND_URL: `http://127.0.0.1:${port}` });
      assert.equal(viaEnv.code, 0, viaEnv.stderr);
      assert.deepEqual(seen, [KEY, "fake-env-key"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("desktop mirror of workspace-mcp-json fixtures", () => {
  it("matches every file", { skip: existsSync(desktopFixturesDir) ? false : `no desktop checkout at ${desktopFixturesDir}` }, () => {
    const ours = readdirSync(fixturesDir).sort();
    assert.deepEqual(readdirSync(desktopFixturesDir).sort(), ours);
    for (const name of ours) {
      assert.equal(readFileSync(join(desktopFixturesDir, name), "utf8"), fixture(name), name);
    }
  });
});
