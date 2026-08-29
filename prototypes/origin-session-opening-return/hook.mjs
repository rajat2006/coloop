#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  EpisodeStore,
  PrototypeError,
  rewritePreToolUse,
  userPromptSubmitOutput,
} from "./origin-adapter.mjs";

try {
  const event = JSON.parse(readFileSync(0, "utf8"));
  let output;
  if (event.hook_event_name === "PreToolUse") {
    output = rewritePreToolUse(event);
  } else if (event.hook_event_name === "UserPromptSubmit") {
    const databasePath =
      process.env.COLOOP_PROTOTYPE_DB ??
      "/tmp/coloop-origin-session-PROTOTYPE-wipe-me.json";
    output = userPromptSubmitOutput(new EpisodeStore(databasePath), event);
  } else {
    throw new PrototypeError(
      `Unsupported hook event ${JSON.stringify(event.hook_event_name)}.`,
    );
  }
  if (Object.keys(output).length > 0) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
