# projects.json format contract

Shared fixtures for `~/.testchimp/projects.json` (schema v2), written by both:

- **TestChimp Studio** — `desktop/src/main/workspace/projectsRegistry.ts` (`upsertWorkspaceFolder`)
- **`@testchimp/cli`** — `src/workspace/projectsRegistry.ts` (`testchimp workspace map`)

The canonical copy lives here (`testchimp-mcp-client/fixtures/projects-registry/`). An identical
copy lives in the Aware repo at `desktop/src/main/workspace/__fixtures__/projectsRegistry/`.
Change both together; each side's contract test fails if the sibling checkout's copy differs.

| Path | Meaning |
|---|---|
| `valid/*.json` | Must parse with both schemas |
| `invalid/*.json` | Must fail both schemas (writers quarantine them as `projects.invalid.<millis>.json`) |
| `legacy/v1.json` | v1 file; both writers migrate it to v2 on first read |
| `edge/*.json` | Valid but unusual: unknown fields, non-canonical key order |
| `sequences.json` | Upsert sequences replayed by both writers |
| `expected/*.json` | Exact bytes each writer must leave on disk after a sequence |

Replay rules (both test suites):

- `__ROOT__` is replaced with the canonical (real) path of a temp dir containing `folders`.
- Step *i* (0-based) runs at `clock.startMillis + i * clock.stepMillis`.
- Generated ids are `idPattern` with `{n12}` = a 12-digit zero-padded counter starting at 1, shared
  across the whole sequence (including v1 migration ids).
- `expectError` steps must throw with that substring and leave the file unchanged.
- `expectedCli` (when present) overrides `expected` for the CLI only: the CLI preserves unknown
  fields, Studio strips them. Both outputs still parse with the other writer's schema.
