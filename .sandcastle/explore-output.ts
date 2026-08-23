import { z } from "zod";

/**
 * The structured `<output>` block emitted after an `agent:explore` run.
 *
 * The agent drafts one Markdown comment that captures its read-only issue
 * investigation. The workflow, not the runner, posts that comment to GitHub.
 * Requiring non-empty content keeps a successful run from publishing a blank
 * assessment and lets the extraction wrapper retry malformed output in-session.
 */
export const exploreOutputSchema = z.object({
  comment: z.string().refine((comment) => comment.trim().length > 0, {
    message: "Exploration comment must contain non-whitespace content.",
  }),
});

export type ExploreOutput = z.infer<typeof exploreOutputSchema>;
