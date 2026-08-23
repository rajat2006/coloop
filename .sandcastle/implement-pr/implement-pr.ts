import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadCapabilityContext } from "../capability-context";
import {
  implementPrOutputSchema,
  type ImplementPrOutput,
} from "../implement-pr-output";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { loadProductivePrompt } from "../productive-prompt";
import { requireEnv } from "../require-env";
import { IDLE_TIMEOUT_SECONDS, logResolvedAgent } from "../resolve-agent";
import { runWithExtraction } from "../run-with-extraction";

/**
 * The `implement-pr` capability: address the review comments on an open PR.
 *
 * Invoked by `.github/workflows/agent-implement-pr.yml` when a PR gets
 * `agent:implement-pr`. A **two-phase** capability ({@link runWithExtraction}):
 * the produce pass reads the PR's review threads, changes what it safely can,
 * runs the repo's checks, and commits the fixes (reasoning in prose); the resumed
 * extraction pass emits one structured `<output>` block recording what it
 * addressed vs deferred — so the agent never has to both do the work and
 * serialise rigid JSON in one turn, and a malformed block self-corrects via
 * same-session retry (≤3×) before anything is posted.
 *
 * The productive agent publishes fix/recovery commits and proves Product CI, but
 * feedback publication remains workflow-owned. This runner writes the summary,
 * replies, and green head SHA to `OUTPUT_DIR`; the workflow revalidates them
 * before posting. Implement-PR never flips draft/ready state.
 */

const ctx = loadCapabilityContext("implement-pr");
// The PR whose review comments we are addressing. Its number is the subject; the
// prompt reads its threads via `gh`. Kept separate from ISSUE_NUMBER (the
// originating spec issue) so the prompt can reference both.
const prNumber = requireEnv("PR_NUMBER");
logResolvedAgent(ctx);

// Same subscription-seat setup as the other agent phases — a no-op when the run
// resolved to Claude.
prepareCodexAuth(ctx.agent.name);

const result = await runWithExtraction({
  name: `implement-pr-#${prNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  // PR_NUMBER augments the shared prompt args (ISSUE_NUMBER/ISSUE_TITLE/BRANCH)
  // so the prompt can point the agent at the PR's own review threads.
  prompt: loadProductivePrompt({
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: { ...ctx.promptArgs, PR_NUMBER: prNumber },
  }),
  extractionPrompt: fs.readFileSync(
    path.join(import.meta.dirname, "extraction.md"),
    "utf8",
  ),
  output: sandcastle.Output.object({
    tag: "output",
    schema: implementPrOutputSchema,
  }),
});

const { body, addressed, deferred } = buildSummaryComment(result.output);

// A run "succeeds" only if it actually produced work or a reason. Guard the two
// ways success would be hollow, so the workflow marks the PR blocked instead of
// pushing a no-op and posting an empty summary (CVM refuses runs that produce
// neither commits nor replies):
//   1. Nothing addressed AND nothing deferred — the agent did nothing at all.
//   2. Output claims `addressed` items but no commits landed — an incoherent
//      extraction (it says it fixed things it never committed).
// An all-deferred run WITH commits === 0 is allowed: the deferred items carry
// their reasons and the summary comment is the "reply" that explains them.
const commits = result.commits.length;
if (commits === 0 && result.output.items.length === 0) {
  fail(
    "Run produced no commits and reported no review comments to address or " +
      "defer — nothing was done. Check the run log; the PR may have had no " +
      "actionable review threads.",
  );
}
if (commits === 0 && addressed > 0) {
  fail(
    `Output marks ${addressed} comment(s) as addressed, but the run committed ` +
      "nothing — the fixes were never committed. Refusing to report success.",
  );
}

fs.writeFileSync(path.join(ctx.outputDir, "pr_comment.md"), body);

// In-thread replies (CVM parity): each addressed item that carried its review
// thread's node ID gets a reply posted by the workflow (invariant H: the runner
// only writes the file; the workflow performs the gh mutation, and validates each
// id against the PR's real threads first). The thread is left open — resolution
// is the reviewer's call, matching CVM.
const replies = buildThreadReplies(result.output);
fs.writeFileSync(
  path.join(ctx.outputDir, "thread_replies.json"),
  JSON.stringify(replies, null, 2),
);
fs.writeFileSync(
  path.join(ctx.outputDir, "implement_pr_head_sha.txt"),
  `${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}\n`,
);

console.log(
  `\nimplement-pr complete: ${result.output.items.length} comment(s) — ` +
    `${addressed} addressed, ${deferred} deferred (${commits} commit(s)); ` +
    `${replies.length} thread repl${replies.length === 1 ? "y" : "ies"} queued.`,
);
console.log(`  ${result.output.summary}`);

/**
 * Build the Markdown the workflow posts as a single PR comment. Groups the items
 * into what was fixed-and-committed vs what was left for a human, so the reviewer
 * can see at a glance which threads the push resolved. Returns the body and the
 * counts for logging.
 */
function buildSummaryComment(review: ImplementPrOutput): {
  body: string;
  addressed: number;
  deferred: number;
} {
  const addressed = review.items.filter((i) => i.status === "addressed");
  const deferred = review.items.filter((i) => i.status === "deferred");

  const lines: string[] = [
    "## 🤖 Addressed review comments",
    "",
    review.summary,
    "",
  ];

  if (review.items.length === 0) {
    lines.push("No actionable review comments were found on the PR.");
  }

  if (addressed.length > 0) {
    lines.push(`### ✅ Addressed (${addressed.length})`, "");
    for (const i of addressed) {
      const where = i.file ? ` \`${i.file}\`` : "";
      lines.push(`-${where} **${i.comment}**`, `  ${i.action}`);
    }
    lines.push("");
  }

  if (deferred.length > 0) {
    lines.push(`### 🔎 Deferred for a human (${deferred.length})`, "");
    for (const i of deferred) {
      const where = i.file ? ` \`${i.file}\`` : "";
      lines.push(`-${where} **${i.comment}**`, `  ${i.action}`);
    }
    lines.push("");
  }

  return {
    body: `${lines.join("\n")}\n`,
    addressed: addressed.length,
    deferred: deferred.length,
  };
}

/** One in-thread reply the workflow posts via the GraphQL API. */
interface ThreadReply {
  readonly threadId: string;
  readonly body: string;
}

/**
 * Collect the in-thread replies to post: one per item that carried its review
 * thread's node ID — whether it was `addressed` (what changed) or `deferred` (why
 * it was left), so a reviewer sees the response on the thread itself, not only in
 * the summary comment (CVM answers both in-thread). The reply body leads with the
 * status so the thread reads clearly; the workflow leaves every thread open for
 * the reviewer to resolve. Items with no `threadId` (top-level comments with no
 * thread to reply on) are covered by the summary comment instead.
 */
function buildThreadReplies(review: ImplementPrOutput): ThreadReply[] {
  return review.items
    .filter((i) => i.threadId !== undefined)
    .map((i) => ({
      threadId: i.threadId as string,
      body:
        i.status === "addressed"
          ? `🤖 **Addressed.** ${i.action}`
          : `🤖 **Left for a human.** ${i.action}`,
    }));
}

/**
 * Fail the run: write the reason where the workflow's `failure()` step reads it
 * (to comment on the PR) and exit non-zero. Same contract as the `implement`
 * capability's `fail()`.
 */
function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  fs.writeFileSync(path.join(ctx.outputDir, "failure_reason.txt"), message);
  process.exit(1);
}
