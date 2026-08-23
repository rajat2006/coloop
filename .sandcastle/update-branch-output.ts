import { z } from "zod";

/**
 * The three terminal states the `update-branch` capability can report.
 *
 * - `merged` — the remote base was merged into the branch (resolving any
 *   conflicts) and a merge commit was made.
 * - `already-current` — the base was already an ancestor of the branch head, so
 *   the merge was a no-op and no commit was made.
 * - `blocked` — the agent could not safely complete the merge (a conflict needing
 *   a product decision) and aborted, leaving the branch untouched for a human.
 *   Carries a `reason`. The runner turns this into a non-zero exit so the
 *   workflow marks the PR `agent:blocked` — the "ask for a human" lifecycle.
 */
export const UPDATE_OUTCOMES = ["merged", "already-current", "blocked"] as const;

/**
 * One merge conflict the agent resolved while bringing the branch current with
 * its base. `file` is a repo-relative path; `resolution` is a one-line prose note
 * on how the two sides were reconciled (which side won, or how they were
 * combined) so a reviewer can sanity-check the resolution without re-diffing.
 */
export const conflictResolutionSchema = z.object({
  file: z.string().min(1),
  resolution: z.string().min(1),
});

/**
 * The structured `<output>` block the `update-branch` capability emits —
 * validated by the extraction wrapper against this schema, so a malformed block
 * self-corrects via same-session retry before the workflow does anything
 * (spec #52 / #67).
 *
 * The agent's claim here is NOT trusted on its own: `update-branch.ts`
 * cross-checks a `merged`/`already-current` claim against the real git state
 * (the base is now an ancestor of HEAD, HEAD advanced, no unresolved paths,
 * no lingering merge state) via
 * {@link import("./verify-branch-update").verifyBranchUpdate} before
 * the workflow pushes. This schema's job is to carry the agent's *intent* — in
 * particular a `blocked` outcome, which git state alone cannot distinguish from
 * an ordinary clean tree.
 *
 * - `summary` — always required; the one-line headline the posted comment leads
 *   with (e.g. "Merged the base into the branch, resolving 2 conflicts.").
 * - `reason` — required when (and only meaningful when) `outcome` is `blocked`:
 *   why a human is needed. Surfaced in the `agent:blocked` comment.
 * - `conflicts` — one entry per file that conflicted and was resolved. Non-empty
 *   only makes sense for `merged`; a `blocked` (aborted) or `already-current`
 *   (no-op) run resolved nothing, so both refinements below reject a non-empty
 *   list there and force an honest re-emit.
 */
export const updateBranchOutputSchema = z
  .object({
    outcome: z.enum(UPDATE_OUTCOMES),
    summary: z.string().min(1),
    conflicts: z.array(conflictResolutionSchema),
    reason: z.string().min(1).optional(),
  })
  .refine((o) => o.outcome !== "blocked" || (o.reason?.length ?? 0) > 0, {
    path: ["reason"],
    message:
      "reason is required when outcome is 'blocked' — it becomes the " +
      "agent:blocked comment explaining why a human is needed",
  })
  .refine((o) => o.outcome === "merged" || o.conflicts.length === 0, {
    path: ["conflicts"],
    message:
      "conflicts must be empty unless outcome is 'merged' — an already-current " +
      "or blocked run merged nothing, so nothing could have conflicted",
  });

export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];
export type UpdateBranchOutput = z.infer<typeof updateBranchOutputSchema>;
