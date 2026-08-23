import { z } from "zod";

/**
 * What the `implement-prd` agent reports after working one sub-issue — the
 * three-way outcome that resolves the zero-commit ambiguity (spec #52's failure
 * guarantee: an agent asking for a human must land the PRD in `agent:blocked`,
 * never be mistaken for "done").
 *
 * - `completed` — the agent implemented the sub-issue in THIS run and committed
 *   the work. The workflow closes the sub-issue and advances.
 * - `already-satisfied` — the sub-issue was already fully implemented by an
 *   earlier run (e.g. a retry after a mid-chain failure), so the agent correctly
 *   made no new commits. Still a success: close and advance.
 * - `blocked` — the agent could not complete it (ambiguous, needs a decision, or
 *   needs a human) and made no commits. The run fails so the sub-issue stays
 *   open and the PRD lands in `agent:blocked`.
 *
 * A plain commit-count check can't tell `already-satisfied` from `blocked` (both
 * produce zero commits) — that is exactly why the agent reports the outcome
 * explicitly rather than the runner inferring it.
 */
export const IMPLEMENT_PRD_OUTCOMES = [
  "completed",
  "already-satisfied",
  "blocked",
] as const;

/**
 * The structured `<output>` block the `implement-prd` extraction pass emits,
 * validated by the extraction wrapper against this schema so a malformed block
 * self-corrects via same-session retry before the workflow acts on it. `reason`
 * is always required — it's the one-line explanation surfaced in logs and, for a
 * `blocked` outcome, in the PRD's `agent:blocked` comment.
 */
export const implementPrdOutputSchema = z.object({
  outcome: z.enum(IMPLEMENT_PRD_OUTCOMES),
  reason: z.string().min(1),
});

export type ImplementPrdOutcome = (typeof IMPLEMENT_PRD_OUTCOMES)[number];
export type ImplementPrdOutput = z.infer<typeof implementPrdOutputSchema>;
