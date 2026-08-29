#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.COLOOP_TEST_CODEX_STATE;

if (args.length === 1 && args[0] === "--version") {
  writeFileSync(1, "codex-cli 0.150.1\n");
  process.exit(0);
}

if (args[0] !== "mcp" || !statePath) process.exit(1);

if (args[1] === "get") {
  try {
    writeFileSync(1, readFileSync(statePath, "utf8"));
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

if (args[1] === "remove") {
  writeFileSync(statePath, "");
  process.exit(0);
}

if (args[1] === "add") {
  const separator = args.indexOf("--");
  const command = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  if (separator < 0 || !command) process.exit(1);
  writeFileSync(
    statePath,
    JSON.stringify({
      enabled: true,
      name: "coloop",
      transport: { args: commandArgs, command, type: "stdio" },
    }),
  );
  process.exit(0);
}

process.exit(1);
