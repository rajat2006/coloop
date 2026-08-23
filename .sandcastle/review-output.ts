import { z } from "zod";

/**
 * The two review axes, mirroring the repo's local `/code-review` skill: does the
 * change follow documented standards, and does it match what the originating
 * issue/spec asked for. The review capability drives that skill and emits its
 * findings tagged by axis, so the posted comment keeps the two lenses separate
 * (see `.agents/skills/code-review/SKILL.md`).
 */
export const REVIEW_AXES = ["standards", "spec"] as const;

/** Severity ladder for a single finding, worst → mildest. */
export const REVIEW_SEVERITIES = [
  "blocking",
  "high",
  "medium",
  "low",
  "nit",
] as const;

/**
 * What the review agent did about a finding within the run.
 *
 * - `fixed` — the agent edited the code and committed a fix; the commit is on the
 *   branch and the workflow pushes it. Reported for the record, not as an
 *   actionable inline comment (the code already changed).
 * - `unresolved` — left for a human: too risky/ambiguous to auto-fix, or out of
 *   scope. Posted as an inline PR-review comment when its line anchors to the
 *   (post-fix) diff, so a reviewer lands on the exact line.
 */
export const REVIEW_STATUSES = ["fixed", "unresolved"] as const;

/**
 * One review finding. `file` is a repo-relative path and `line` (optional) a
 * new-side line number the review capability cross-checks against the actual PR
 * diff via {@link import("./parse-diff-lines").parseDiffLines} before posting, so
 * an inline anchor can't point a reviewer at a line the change never touched (and
 * so the GitHub reviews API, which rejects a whole review with an off-diff
 * comment, isn't handed a bad anchor).
 */
export const reviewFindingSchema = z.object({
  axis: z.enum(REVIEW_AXES),
  severity: z.enum(REVIEW_SEVERITIES),
  status: z.enum(REVIEW_STATUSES),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
});

/**
 * The structured `<output>` block the `review` capability emits — validated by
 * the extraction wrapper against this schema, so a malformed block self-corrects
 * via same-session retry before the workflow posts anything (spec #52 / #65).
 *
 * `findings` may be empty: a clean review is a valid review, and the PR is still
 * marked ready. `summary` is always required — it's the one-line headline the
 * posted comment leads with.
 */
export const reviewOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(reviewFindingSchema),
});

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
