import type { ImplementPrdOutcome } from "./implement-prd-output";

/**
 * The facts the `implement-prd` runner cross-checks the agent's reported outcome
 * against: the outcome the agent claimed and how many commits it actually made
 * on the branch THIS run.
 */
export interface ImplementPrdFacts {
  readonly outcome: ImplementPrdOutcome;
  readonly commitCount: number;
}

/** `{ ok: true }` when the run may advance; `{ ok: false, reason }` to block. */
export type ImplementPrdVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Cross-check the agent's reported outcome against the real commit count, so a
 * self-contradictory claim fails the run rather than closing a sub-issue on a
 * false premise (spec #52's failure guarantee; mirrors `verifyBranchUpdate`).
 *
 * The outcome and the commit count must agree:
 *
 * - `completed` → **> 0** commits. Claiming the work was done this run while
 *   committing nothing is a contradiction — fail closed rather than close
 *   unfinished work.
 * - `already-satisfied` → **0** commits. The outcome *means* "no new work was
 *   needed"; new commits under that claim contradict it — fail closed.
 * - `blocked` → always a failure: the agent could not finish, so the sub-issue
 *   stays open and the PRD lands in `agent:blocked`.
 *
 * A plain commit-count check can't do this on its own — it can't tell an
 * already-done sub-issue (0 commits, fine) from an agent that gave up (0 commits,
 * must block). The agent's outcome supplies intent; this verifier makes sure the
 * intent and the git reality are consistent before the workflow acts.
 */
export function verifyImplementPrdOutcome(
  facts: ImplementPrdFacts,
): ImplementPrdVerdict {
  const { outcome, commitCount } = facts;
  switch (outcome) {
    case "completed":
      return commitCount > 0
        ? { ok: true }
        : {
            ok: false,
            reason:
              'reported "completed" but made no commits this run — treating as ' +
              "blocked to avoid closing unfinished work.",
          };
    case "already-satisfied":
      return commitCount === 0
        ? { ok: true }
        : {
            ok: false,
            reason:
              `reported "already-satisfied" (no new work expected) but made ` +
              `${commitCount} new commit(s) this run — contradictory, so failing closed.`,
          };
    case "blocked":
      return {
        ok: false,
        reason: 'reported "blocked": the sub-issue could not be completed.',
      };
  }
}
