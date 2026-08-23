import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadPrdImplementContext } from "../capability-context";
import { implementPrdOutputSchema } from "../implement-prd-output";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { loadProductivePrompt } from "../productive-prompt";
import { IDLE_TIMEOUT_SECONDS, logResolvedAgent } from "../resolve-agent";
import { runWithExtraction } from "../run-with-extraction";
import { verifyImplementPrdOutcome } from "../verify-implement-prd";

/**
 * The `implement-prd` capability: implement ONE still-open sub-issue of a PRD
 * onto its accumulating branch, and report an explicit outcome.
 *
 * Invoked by `.github/workflows/agent-implement-prd.yml` once per sub-issue. The
 * workflow drives the PRD forward incrementally — resume the branch, run this for
 * the first open sub-issue, close it, re-label the PRD to fetch the next; review
 * is requested only when every sub-issue is closed.
 *
 * A **two-phase** capability ({@link runWithExtraction}): the produce pass
 * implements the sub-issue (reasoning in prose, committing its work); the resumed
 * extraction pass emits a `completed | already-satisfied | blocked` outcome. That
 * three-way outcome is the point — a plain commit-count guard can't tell an
 * already-done sub-issue (legitimately zero commits) from an agent that gave up
 * and asked for a human (also zero commits), and closing the latter as "done"
 * would silently drop unfinished work (spec #52's failure guarantee). So the
 * agent reports which case it is, and this script fails the run on `blocked` (and
 * on the contradiction of `completed` with no new commits) — leaving the
 * sub-issue open and the PRD `agent:blocked` — while `completed`/`already-satisfied`
 * let the workflow close the sub-issue and advance.
 *
 * The productive agent may publish this branch, upsert its draft PR, and recover
 * Product CI under the shared prompt contract. Lifecycle mutations remain in the
 * workflow. On failure this runner writes `failure_reason.txt` for the blocked
 * path. Provider is resolved from the PRD's full label set.
 */

const ctx = loadPrdImplementContext("implement-prd");
logResolvedAgent(ctx);

// Materialise the Codex subscription seat (auth.json + file credential store,
// OPENAI_* stripped) before the run — a no-op when the run resolved to Claude.
prepareCodexAuth(ctx.agent.name);

const result = await runWithExtraction({
  name: `implement-prd-#${ctx.prdNumber}-sub-#${ctx.subIssueNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  prompt: loadProductivePrompt({
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: ctx.promptArgs,
  }),
  extractionPrompt: fs.readFileSync(
    path.join(import.meta.dirname, "extraction.md"),
    "utf8",
  ),
  output: sandcastle.Output.object({
    tag: "output",
    schema: implementPrdOutputSchema,
  }),
});

const { outcome, reason } = result.output;
const commitsThisRun = result.commits.length;
console.log(`\nSub-issue #${ctx.subIssueNumber} outcome: ${outcome} — ${reason}`);
console.log(`  commits this run: ${commitsThisRun}`);

// Cross-check the agent's claimed outcome against the real commit count (a pure,
// tested verifier). The three outcomes must each agree with the git reality:
// completed ⇒ commits > 0, already-satisfied ⇒ commits == 0, blocked ⇒ always a
// failure. Any mismatch fails the run so the workflow leaves the sub-issue OPEN
// and marks the PRD `agent:blocked`, never closing it on a self-contradictory
// claim. Surface the agent's own `reason` for a blocked outcome.
const verdict = verifyImplementPrdOutcome({ outcome, commitCount: commitsThisRun });
if (!verdict.ok) {
  const detail = outcome === "blocked" ? reason : verdict.reason;
  fail(`Sub-issue #${ctx.subIssueNumber} ${verdict.reason} (agent: ${detail})`);
}

// A consistent `completed` (with commits) or `already-satisfied` (no commits) —
// the workflow closes the sub-issue and advances to the next one.

/**
 * Fail the run: write the reason where the workflow's `failure()` step reads it
 * (to comment on the PRD) and exit non-zero.
 */
function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  fs.writeFileSync(path.join(ctx.outputDir, "failure_reason.txt"), message);
  process.exit(1);
}
