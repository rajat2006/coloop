import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadCapabilityContext } from "../capability-context";
import { parseDiffLines } from "../parse-diff-lines";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { loadProductivePrompt } from "../productive-prompt";
import { IDLE_TIMEOUT_SECONDS, logResolvedAgent } from "../resolve-agent";
import { reviewOutputSchema, type ReviewOutput } from "../review-output";
import { runWithExtraction } from "../run-with-extraction";

/**
 * The `review` capability: drive the repo's local `/code-review` over the PR
 * branch, fix what can be fixed safely, and emit the findings as one structured
 * `<output>` block.
 *
 * Invoked by `.github/workflows/agent-review.yml` when a PR gets `agent:review`.
 * A **two-phase** capability ({@link runWithExtraction}): the produce pass runs
 * `/code-review`, applies + commits fixes, and re-reviews (reasoning in prose);
 * the resumed extraction pass emits the findings JSON — so the agent never has to
 * both review and serialise rigid JSON in one turn, and a malformed block
 * self-corrects via same-session retry (≤3×) before anything is posted.
 *
 * The productive agent publishes fix/recovery commits and proves Product CI, but
 * review publication remains workflow-owned. This runner writes the final
 * `review_payload.json` and reviewed head SHA to `OUTPUT_DIR`; the workflow
 * revalidates both before posting and before `gh pr ready`.
 */

const ctx = loadCapabilityContext("review");
const reviewBase = `origin/${ctx.baseBranch}`;
logResolvedAgent(ctx);

// Same subscription-seat setup as the other agent phases — a no-op when the run
// resolved to Claude.
prepareCodexAuth(ctx.agent.name);

const result = await runWithExtraction({
  name: `review-#${ctx.issueNumber}`,
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
  output: sandcastle.Output.object({ tag: "output", schema: reviewOutputSchema }),
});

// The diff now includes the agent's fix/recovery commits, so its new-side line
// numbers are the ones an inline review comment must anchor to — GitHub's reviews
// API rejects the whole review if any comment points off-diff.
const diff = execFileSync("git", ["diff", `${reviewBase}...HEAD`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const changed = parseDiffLines(diff);
const reviewedHead = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

const { payload, inline, fixed, unresolved } = buildReviewPayload(
  result.output,
  changed,
  reviewedHead,
);
fs.writeFileSync(
  path.join(ctx.outputDir, "review_payload.json"),
  JSON.stringify(payload, null, 2),
);
fs.writeFileSync(
  path.join(ctx.outputDir, "review_head_sha.txt"),
  `${reviewedHead}\n`,
);

console.log(
  `\nReview complete: ${result.output.findings.length} finding(s) — ` +
    `${fixed} auto-fixed, ${unresolved} unresolved (${inline} posted inline).`,
);
console.log(`  ${result.output.summary}`);

/** One inline comment in the GitHub "create a review" request body. */
interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
}

/** The GitHub "create a review" request body (POST /pulls/{n}/reviews). */
interface ReviewPayload {
  readonly commit_id: string;
  readonly event: "COMMENT";
  readonly body: string;
  readonly comments: InlineComment[];
}

/**
 * Build the reviews-API payload the workflow posts. Unresolved findings whose
 * line is genuinely a changed line become inline comments (anchored `file:line`);
 * unresolved findings without a valid anchor fall back to a "needs attention"
 * list in the body; fixed findings are listed for the record (their code already
 * changed). Returns the payload and counts for logging.
 */
function buildReviewPayload(
  review: ReviewOutput,
  changedLines: Map<string, Set<number>>,
  commitId: string,
): {
  payload: ReviewPayload;
  inline: number;
  fixed: number;
  unresolved: number;
} {
  const fixed = review.findings.filter((f) => f.status === "fixed");
  const unresolved = review.findings.filter((f) => f.status === "unresolved");

  const comments: InlineComment[] = [];
  const unanchored: typeof unresolved = [];
  for (const f of unresolved) {
    if (f.line !== undefined && changedLines.get(f.file)?.has(f.line)) {
      comments.push({
        path: f.file,
        line: f.line,
        side: "RIGHT",
        body: `**[${f.axis} · ${f.severity}]** ${f.title}\n\n${f.detail}`,
      });
    } else {
      unanchored.push(f);
    }
  }

  const body: string[] = ["## 🤖 Automated review", "", review.summary, ""];

  if (review.findings.length === 0) {
    body.push("No standards or spec findings — the branch is clean.");
  }

  if (fixed.length > 0) {
    body.push(`### ✅ Auto-fixed (${fixed.length})`, "");
    for (const f of fixed) {
      body.push(`- **[${f.axis} · ${f.severity}]** \`${f.file}\` — ${f.title}`);
    }
    body.push("");
  }

  if (unanchored.length > 0) {
    body.push(`### 🔎 Needs attention (${unanchored.length})`, "");
    for (const f of unanchored) {
      body.push(
        `- **[${f.axis} · ${f.severity}]** \`${f.file}\` — ${f.title}`,
        `  ${f.detail}`,
      );
    }
    body.push("");
  }

  if (comments.length > 0) {
    body.push(
      `${comments.length} more unresolved finding(s) are posted as inline comments below.`,
    );
  }

  return {
    payload: {
      commit_id: commitId,
      event: "COMMENT",
      body: `${body.join("\n")}\n`,
      comments,
    },
    inline: comments.length,
    fixed: fixed.length,
    unresolved: unresolved.length,
  };
}
