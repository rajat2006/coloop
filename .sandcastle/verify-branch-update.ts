import type { UpdateOutcome } from "./update-branch-output";

/**
 * A snapshot of the real git state around an `update-branch` run, gathered by
 * `update-branch.ts` from `git` and handed to {@link verifyBranchUpdate}. Keeping
 * the checks in a pure function (facts in, verdict out) makes the postconditions
 * unit-testable without a git repo — the runner is the only part that shells out.
 */
export interface BranchUpdateFacts {
  /** What the agent *claims* happened. Only success claims are verified here. */
  readonly claimedOutcome: UpdateOutcome;
  /** The remote-tracking ref being incorporated, such as `origin/dev`. */
  readonly baseRef: string;
  /** The base ref is an ancestor of HEAD now (the base is fully incorporated). */
  readonly baseIsAncestor: boolean;
  /** The base ref was already an ancestor of HEAD *before* the run. */
  readonly baseWasAncestorBefore: boolean;
  /** A merge is still in progress (`.git/MERGE_HEAD` present). */
  readonly inMergeState: boolean;
  /** Paths still unmerged after the run (conflicts left unresolved). */
  readonly unresolvedPaths: readonly string[];
  /** The working tree / index has uncommitted changes. */
  readonly treeDirty: boolean;
  /** HEAD sha before the run. */
  readonly headBefore: string;
  /** HEAD sha after the run. */
  readonly headAfter: string;
}

/** The outcome of {@link verifyBranchUpdate}. */
export type BranchUpdateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Cross-check an agent's *success* claim (`merged` or `already-current`) against
 * the real git state before the workflow is allowed to push. The agent's JSON is
 * not trusted on its own: the prompt permits `git merge --abort`, so an agent
 * that gives up can still emit a success-shaped block — deterministic
 * postconditions (CVM parity) are what stop an aborted or half-finished merge
 * from being pushed and reported as a successful merge.
 *
 * A `blocked` claim is NOT the concern of this function — the runner routes that
 * to failure with the agent's own `reason` before calling here. If a `blocked`
 * outcome reaches this function it is treated as a verification failure, since a
 * blocked run must never be pushed.
 *
 * Returns `{ ok: true }` when every postcondition holds, or `{ ok: false, reason }`
 * with a human-readable reason the runner writes to `failure_reason.txt` for the
 * `agent:blocked` comment.
 */
export function verifyBranchUpdate(
  facts: BranchUpdateFacts,
): BranchUpdateVerdict {
  if (facts.claimedOutcome === "blocked") {
    return {
      ok: false,
      reason:
        "Agent reported the merge is blocked and needs a human — the branch " +
        "was not updated.",
    };
  }

  // Shared postconditions for any successful update: the merge must be finished,
  // conflict-free, committed, and must actually incorporate the base.
  if (facts.inMergeState) {
    return {
      ok: false,
      reason:
        "The repository is still mid-merge (MERGE_HEAD present) — the merge was " +
        "never committed. A resolution was left half-done.",
    };
  }
  if (facts.unresolvedPaths.length > 0) {
    return {
      ok: false,
      reason: `Unresolved merge conflicts remain in: ${facts.unresolvedPaths.join(", ")}.`,
    };
  }
  if (facts.treeDirty) {
    return {
      ok: false,
      reason:
        "The working tree has uncommitted changes after the merge — the " +
        "resolution was not committed.",
    };
  }
  if (!facts.baseIsAncestor) {
    return {
      ok: false,
      reason:
        `${facts.baseRef} is not an ancestor of HEAD — the branch was not ` +
        "brought current with its base (the merge may have been aborted).",
    };
  }

  // Outcome-specific: the claim must match what actually happened to HEAD. We
  // check that HEAD *advanced* (a new commit landed) and — via baseIsAncestor
  // above — that it now incorporates the base; we do NOT assert HEAD is
  // literally a 2-parent merge commit, since a legitimate merge-then-fixup would
  // then fail. The later non-force push is what guards against rewritten history.
  if (facts.claimedOutcome === "merged" && facts.headAfter === facts.headBefore) {
    return {
      ok: false,
      reason:
        "Agent reported a merge but HEAD did not advance — no new commit " +
        "landed. If the branch was already current it should report " +
        "already-current instead.",
    };
  }
  if (
    facts.claimedOutcome === "already-current" &&
    facts.headAfter !== facts.headBefore
  ) {
    return {
      ok: false,
      reason:
        "Agent reported already-current but HEAD moved — a commit was made, so " +
        "the branch was not already current.",
    };
  }
  if (facts.claimedOutcome === "already-current" && !facts.baseWasAncestorBefore) {
    return {
      ok: false,
      reason:
        `Agent reported already-current but ${facts.baseRef} was not an ancestor of ` +
        "HEAD before the run — the branch genuinely needed a merge.",
    };
  }

  return { ok: true };
}
