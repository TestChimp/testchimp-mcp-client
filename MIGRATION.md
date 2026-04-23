# Migrating from `testchimp-mcp-client` to `@testchimp/cli`

1. **MCP host config** — Replace package name and add the `mcp` subcommand:

   ```json
   "args": ["-y", "@testchimp/cli@latest", "mcp"]
   ```

2. **Tool names** — MCP tools are now **kebab-case** (e.g. `create-user-story` instead of `create_user_story`). Update skills, prompts, and docs accordingly.

3. **npm** — Install `@testchimp/cli`; remove `testchimp-mcp-client` from `devDependencies` if present.

4. **Optional npm shim** — To keep the old package name resolving for a transition period, publish a thin `testchimp-mcp-client` package that depends on `@testchimp/cli` and sets `bin.testchimp-mcp` to `node_modules/@testchimp/cli/dist/bin/legacy-mcp.js` (publish separately if needed).
