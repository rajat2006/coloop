import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadCapabilityContext } from "../capability-context";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { loadProductivePrompt } from "../productive-prompt";
import { IDLE_TIMEOUT_SECONDS, logResolvedAgent } from "../resolve-agent";

/**
 * The `implement` capability: work a ready issue into commits on its branch.
 *
 * Invoked by `.github/workflows/agent-implement.yml` AFTER the branch is cut
 * from the configured base branch. This is the one capability that calls
 * `run()` directly — no
 * structured output, neither wrapper — because the *work is the commits*, which
 * the workflow (not the agent) pushes. There is nothing to extract.
 *
 * The only post-run guard is a commit-count check: a run that finished without
 * committing anything fails loudly (writing the reason for the workflow's
 * blocked path) rather than pushing an empty branch and opening an empty PR.
 */

const ctx = loadCapabilityContext("implement");
logResolvedAgent(ctx);

// Materialise the Codex subscription seat (auth.json + file credential store,
// OPENAI_* stripped) before the run — a no-op when the run resolved to Claude.
prepareCodexAuth(ctx.agent.name);

const result = await sandcastle.run({
  name: `implement-#${ctx.issueNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  prompt: loadProductivePrompt({
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: ctx.promptArgs,
  }),
});

const commitsAhead = Number(
  execFileSync("git", ["rev-list", "--count", `${ctx.baseBranch}..HEAD`], {
    encoding: "utf8",
  }).trim(),
);
if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
  fail("Agent finished but made no commits on the branch.");
}

console.log(
  `\nImplementation produced ${commitsAhead} commit(s) on ${ctx.branch}.`,
);
console.log(`  commits captured this run: ${result.commits.length}`);

/**
 * Fail the run: write the reason where the workflow's `failure()` step reads it
 * (to comment on the issue) and exit non-zero.
 */
function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  fs.writeFileSync(path.join(ctx.outputDir, "failure_reason.txt"), message);
  process.exit(1);
}
