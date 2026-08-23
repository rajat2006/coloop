import { z } from "zod";

/**
 * What a single `architecture-review` run decided. Mirroring CVM's
 * `improve-codebase-architecture` capability field-for-field
 * (`{status, title, body, oneLineSummary, candidatesConsidered}`): a run weighs
 * a handful of deepening candidates and either **proposes** the single freshest
 * one as a PRD or **skips**.
 *
 * - `proposed` — one deepening opportunity, not already covered by an open *or
 *   closed* `source:architecture-review` proposal, written up as a PRD
 *   (`title` + `body`) with the candidates weighed (`candidatesConsidered`) and a
 *   `oneLineSummary`. The workflow opens that PRD and labels it
 *   `source:architecture-review`; a human later expands it with `agent:to-issues`.
 * - `skipped` — nothing fresh worth proposing (the codebase is clean, or every
 *   candidate is already a past proposal). Just `{status, reason}`, per CVM.
 */
export const ARCHITECTURE_STATUSES = ["proposed", "skipped"] as const;

/**
 * The structured `<output>` block the `architecture-review` capability emits,
 * copied field-for-field from CVM — `proposed` is
 * `{status, title, body, oneLineSummary, candidatesConsidered}`, `skipped` is
 * `{status, reason}` — as a **strict discriminated union on `status`** so the
 * contract is enforced, not just documented: a `proposed` block *must* carry
 * `title` + `body` + at least one non-empty candidate, a `skipped` block carries
 * *only* a `reason`, and neither can smuggle the other branch's fields (`.strict()`
 * ⇒ extra keys rejected, not stripped). Validated by the extraction wrapper, so a
 * malformed or mixed block self-corrects via same-session retry before the
 * workflow opens any PRD (spec #52 / #70).
 *
 * One proposal per run (not a findings list): CVM proposes a single fresh
 * deepening opportunity at a time so each becomes its own PRD → child-issues
 * flow, rather than a rolling report.
 */
export const architectureReviewOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("proposed"),
      /** One-line headline of the deepening being proposed. */
      oneLineSummary: z.string().min(1),
      /** PRD title — imperative, within GitHub's 256-char issue-title limit. */
      title: z.string().min(1).max(256),
      /** The full PRD body (the seven-section spec shape) as Markdown. */
      body: z.string().min(1),
      /**
       * The candidate deepening opportunities the run weighed (each a short
       * non-empty label, the chosen one included) — at least one, per CVM, so the
       * Actions summary always has something to report.
       */
      candidatesConsidered: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("skipped"),
      /** One-line reason nothing was proposed (drives the Actions summary). */
      reason: z.string().min(1),
    })
    .strict(),
]);

export type ArchitectureStatus = (typeof ARCHITECTURE_STATUSES)[number];
export type ArchitectureReviewOutput = z.infer<
  typeof architectureReviewOutputSchema
>;
