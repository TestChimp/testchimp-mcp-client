# `.testchimp/mcp.json` format fixtures

Shared by `testchimp workspace save-creds` (this repo, `src/workspace/workspaceCredsFile.ts`) and TestChimp
Studio (desktop `src/main/workspace/mcpLifecycle.ts`, `src/main/opencode/workspaceCreds.ts`). An identical copy
lives in the desktop repo under `src/main/workspace/__fixtures__/workspaceMcpJson/`; keep both byte-for-byte equal.

Inputs: project `proj-fixture-1`, key `fake-project-key-0001` (fake).

| File | Meaning |
|---|---|
| `expected-fresh-prod.json` | No existing file; production backend (no `TESTCHIMP_BACKEND_URL`), production ingress |
| `expected-fresh-staging.json` | No existing file; `https://featureservice-staging.testchimp.io` / `https://ingress-staging.testchimp.io` |
| `existing-other-servers.json` | A project file holding only user-registered servers |
| `expected-merged-prod.json` | `existing-other-servers.json` after saving prod creds: other servers kept, `testchimp` appended |

Both writers must produce these bytes (2-space JSON, trailing newline, file mode `0600`), and Studio's
`readWorkspaceCreds` must read the key, project, backend and ingress back from them.
