#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { runCodexHook } from "@coloop/coding-agent-codex";
import { runMcpServer } from "@coloop/coding-agent-protocol";
import { getInstallationPaths } from "@coloop/local-storage";
import { createCodexPromptReturner } from "@coloop/runtime";
import { createProductionDependencies } from "./production-dependencies.js";
import { runCli } from "./run-cli.js";

const dependencies = createProductionDependencies({
  args: [fileURLToPath(import.meta.url)],
  command: process.execPath,
}, process.env);

const args = process.argv.slice(2);
// Codex installs these two internal entry points; setup and run remain the Owner-facing CLI.
if (args[0] === "mcp") {
  process.exitCode = await runMcpServer(process.stdin, process.stdout);
} else if (args[0] === "codex-hook") {
  const promptReturner = createCodexPromptReturner({
    databasePath: getInstallationPaths(process.env).databaseFile,
    ...(dependencies.telemetry === undefined
      ? {}
      : { telemetry: dependencies.telemetry }),
  });
  process.exitCode = await runCodexHook(
    args[1],
    process.stdin,
    process.stdout,
    process.stderr,
    promptReturner,
  );
} else if (args.length === 1 && args[0] === "verify-entrypoint") {
  process.exitCode = 0;
} else {
  process.exitCode = await runCli(args, dependencies);
}
