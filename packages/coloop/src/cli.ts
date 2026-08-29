#!/usr/bin/env node

import { runCli } from "./cli-application.js";
import { runCodexHook } from "./hooks.js";
import { runMcpServer } from "./mcp.js";
import { createProductionDependencies } from "./providers.js";

const args = process.argv.slice(2);
if (args[0] === "mcp") {
  process.exitCode = await runMcpServer(process.stdin, process.stdout);
} else if (args[0] === "codex-hook") {
  process.exitCode = await runCodexHook(
    args[1],
    process.stdin,
    process.stdout,
    process.stderr,
  );
} else {
  process.exitCode = await runCli(args, createProductionDependencies());
}
