import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadCapabilityContext } from "../capability-context";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { IDLE_TIMEOUT_SECONDS, logResolvedAgent } from "../resolve-agent";
import { runWithExtraction } from "../run-with-extraction";
import {
  updateBranchOutputSchema,
  type UpdateBranchOutput,
} from "../update-branch-output";
import { verifyBranchUpdate } from "../verify-branch-update";

/**
 * The `update-branch` capability: resolve the merge conflicts that stop a stale
 * PR branch from coming current with its base branch, and commit the merge.
 *
 * Invoked by `.github/workflows/agent-update-branch.yml` ONLY when the workflow's
 * deterministic base-branch merge hit conflicts — an already-current or
 * cleanly-mergeable branch is handled in the workflow without spending an agent
 * (CVM parity). A **two-phase** capability ({@link runWithExtraction}): the
 * produce pass re-merges the base, resolves the conflicts, runs the repo's
 * checks, and commits (reasoning in prose); the resumed extraction pass emits the
 * outcome as one `<output>` block — so the agent never has to both resolve a
 * merge and serialise rigid JSON in one turn, and a malformed block self-corrects
 * via same-session retry (≤3×).
 *
 * The agent's claim is NOT trusted on its own. The prompt permits
 * `git merge --abort` when a conflict needs a human, so a give-up can still emit
 * a success-shaped block. Two guards convert that into a real `agent:blocked`:
 *   1. An explicit `outcome: blocked` fails the run with the agent's reason.
 *   2. {@link verifyBranchUpdate} cross-checks a success claim against the real
 *      git state (the base is now an ancestor of HEAD, HEAD advanced, no
 *      unresolved paths, no lingering merge state, a clean tree) — a failed
 *      postcondition fails the run — so an aborted or half-finished merge is
 *      never pushed.
 *
 * Per invariant H the runner emits ONLY commits + output files: the merge commit
 * lands on the branch (the workflow pushes it — a plain, non-force push) and
 * `update_branch_comment.md` is written to `OUTPUT_DIR`. The workflow pushes and
 * posts that comment.
 */

const ctx = loadCapabilityContext("update-branch");
const baseRef = `origin/${ctx.baseBranch}`;
logResolvedAgent(ctx);

// Same subscription-seat setup as the other agent phases — a no-op when the run
// resolved to Claude.
prepareCodexAuth(ctx.agent.name);

// Snapshot the pre-run git state so the postcondition check can tell "a merge
// commit was actually made" from "nothing changed" (see verifyBranchUpdate).
const headBefore = gitOut("rev-parse", "HEAD");
const baseWasAncestorBefore = gitOk(
  "merge-base",
  "--is-ancestor",
  baseRef,
  "HEAD",
);

const result = await runWithExtraction({
  name: `update-branch-#${ctx.issueNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: ctx.promptArgs,
  extractionPrompt: fs.readFileSync(
    path.join(import.meta.dirname, "extraction.md"),
    "utf8",
  ),
  output: sandcastle.Output.object({
    tag: "output",
    schema: updateBranchOutputSchema,
  }),
});

// Guard 1: the agent asked for a human. The schema guarantees a reason here.
if (result.output.outcome === "blocked") {
  fail(
    result.output.reason ??
      "Agent reported the merge is blocked and needs a human.",
  );
}

// Guard 2: verify the agent's success claim against the real git state before
// the workflow is allowed to push anything.
const verdict = verifyBranchUpdate({
  claimedOutcome: result.output.outcome,
  baseRef,
  headBefore,
  headAfter: gitOut("rev-parse", "HEAD"),
  baseWasAncestorBefore,
  baseIsAncestor: gitOk("merge-base", "--is-ancestor", baseRef, "HEAD"),
  inMergeState: gitOk("rev-parse", "-q", "--verify", "MERGE_HEAD"),
  unresolvedPaths: gitLines("diff", "--name-only", "--diff-filter=U"),
  treeDirty: gitOut("status", "--porcelain").length > 0,
});
if (!verdict.ok) {
  fail(`Post-merge verification failed: ${verdict.reason}`);
}

fs.writeFileSync(
  path.join(ctx.outputDir, "update_branch_comment.md"),
  buildUpdateComment(result.output),
);

console.log(
  `\nUpdate-branch complete: ${result.output.outcome} — ` +
    `${result.output.conflicts.length} conflict(s) resolved.`,
);
console.log(`  ${result.output.summary}`);

/**
 * Build the PR-comment body the workflow posts. Leads with the one-line summary,
 * then lists each resolved conflict so a reviewer can spot-check the merge. Only
 * a verified success (`merged` / `already-current`) reaches here — `blocked`
 * exits above via the workflow's failure path.
 */
function buildUpdateComment(output: UpdateBranchOutput): string {
  const body: string[] = ["## 🔄 Branch update", "", output.summary, ""];

  if (output.outcome === "already-current") {
    body.push(
      `The branch was already current with \`${ctx.baseBranch}\` — no merge was made.`,
    );
  } else if (output.conflicts.length === 0) {
    body.push(`Merged \`${ctx.baseBranch}\` in cleanly — no conflicts.`);
  } else {
    body.push(`### Conflicts resolved (${output.conflicts.length})`, "");
    for (const c of output.conflicts) {
      body.push(`- \`${c.file}\` — ${c.resolution}`);
    }
  }

  return `${body.join("\n")}\n`;
}

/** Run a git command and return its trimmed stdout. */
function gitOut(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Run a git command for its exit status; true when it exits 0. */
function gitOk(...args: string[]): boolean {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run a git command and return its non-empty output lines, trimmed. */
function gitLines(...args: string[]): string[] {
  return gitOut(...args)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Fail the run: write the reason where the workflow's `failure()` step reads it
 * (to comment on the PR) and exit non-zero. Same contract as the `implement` and
 * `implement-pr` capabilities' `fail()`.
 */
function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  fs.writeFileSync(path.join(ctx.outputDir, "failure_reason.txt"), message);
  process.exit(1);
}
