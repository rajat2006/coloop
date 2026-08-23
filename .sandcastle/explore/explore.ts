import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadIssueCapabilityContext } from "../capability-context";
import { exploreOutputSchema } from "../explore-output";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { requireEnv } from "../require-env";
import { IDLE_TIMEOUT_SECONDS, logResolvedAgent } from "../resolve-agent";
import { runWithExtraction } from "../run-with-extraction";
import { verifyExploreReadOnly } from "../verify-explore-read-only";

/**
 * Investigate one issue without implementing it, then write the structured
 * assessment for the workflow to publish as an issue comment.
 *
 * The produce pass performs the potentially long repository investigation; the
 * resumed extraction pass serialises that completed assessment without asking
 * the agent to repeat its work. The runner mutates no GitHub state and writes no
 * repository files — `comment.md` in `OUTPUT_DIR` is its only artifact.
 */

const ctx = loadIssueCapabilityContext("explore");
logResolvedAgent(ctx);
const issueContext = fs.readFileSync(requireEnv("ISSUE_CONTEXT_FILE"), "utf8");
const initialHead = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

prepareCodexAuth(ctx.agent.name);

const result = await runWithExtraction({
  name: `explore-#${ctx.issueNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: { ...ctx.promptArgs, ISSUE_CONTEXT: issueContext },
  extractionPrompt: fs.readFileSync(
    path.join(import.meta.dirname, "extraction.md"),
    "utf8",
  ),
  output: sandcastle.Output.object({
    tag: "output",
    schema: exploreOutputSchema,
  }),
});

const verification = verifyExploreReadOnly({
  initialHead,
  finalHead: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  porcelainStatus: execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }),
});
if (!verification.ok) {
  fs.writeFileSync(
    path.join(ctx.outputDir, "failure_reason.txt"),
    verification.reason,
  );
  throw new Error(verification.reason);
}

fs.writeFileSync(path.join(ctx.outputDir, "comment.md"), result.output.comment);
console.log(`Exploration comment written for issue #${ctx.issueNumber}.`);
