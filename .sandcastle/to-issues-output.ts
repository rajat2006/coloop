import { z } from "zod";

/**
 * One vertical slice the `to-issues-prd` capability decomposes a PRD into —
 * emitted as **structured fields**, never as a pre-rendered issue body.
 *
 * Copies CVM's runner-neutral to-issues contract field-for-field: a `title`
 * (capped at CVM's 200 chars), the `whatToBuild` prose, and the
 * `acceptanceCriteria` list. There is **no dependency field** — CVM uses the
 * emitted *list order* as the only phase signal (earlier slices land first). The
 * agent supplies the content; the runner {@link renderSliceBody} deterministically
 * renders the Markdown body, so a malformed, non-agent-ready body can't be
 * published verbatim (spec #52 / #69).
 *
 * `acceptanceCriteria` requires at least one entry — an agent-sized slice with no
 * checkable outcome is not actionable — so an empty list triggers a same-session
 * retry. No `labels` field: the workflow deliberately applies no state label, so
 * a human triages each slice before it enters the agent lane.
 */
export const sliceSchema = z.object({
  title: z.string().min(1).max(200),
  whatToBuild: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

/**
 * The structured `<output>` block the `to-issues-prd` capability emits —
 * validated by {@link import("./run-with-retry").runWithRetry} against this
 * schema (CVM's `PromptOutput`), so a malformed or empty block self-corrects via
 * same-session retry before the workflow creates anything (spec #52 / #69).
 *
 * `slices` requires at least one entry: a decomposition that yields zero slices
 * is not a decomposition. Deliberately no `summary` field — CVM's contract has
 * none; the workflow's PRD comment lists the created sub-issues directly.
 */
export const toIssuesOutputSchema = z.object({
  slices: z.array(sliceSchema).min(1),
});

export type Slice = z.infer<typeof sliceSchema>;
export type ToIssuesOutput = z.infer<typeof toIssuesOutputSchema>;

/**
 * Deterministically render a validated {@link Slice} into the Markdown body the
 * workflow feeds to `gh issue create --body-file`. Byte-for-byte CVM's
 * `renderBody`: the `## Parent PRD` back-reference, the `## What to build` prose,
 * and the `## Acceptance criteria` checklist are fixed here — not left to the
 * agent — so every published sub-issue lands in the same shape. `prdNumber` is
 * the PRD's issue number; the trailing newline keeps the file POSIX-clean.
 */
export function renderSliceBody(
  slice: Slice,
  prdNumber: string | number,
): string {
  const criteria = slice.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n");
  return `## Parent PRD

#${prdNumber}

## What to build

${slice.whatToBuild}

## Acceptance criteria

${criteria}
`;
}
