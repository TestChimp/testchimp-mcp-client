#!/usr/bin/env node
import { buildCliProgram } from "../cli/program.js";

const program = buildCliProgram();

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
