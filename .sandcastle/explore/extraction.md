# EMIT THE ISSUE EXPLORATION

You have finished investigating the issue. Now emit the assessment as exactly
one `<output>` JSON block, as the last thing in your response. Do not investigate
or change anything further — only serialize the findings you already reached.

The block must match this shape:

<output>
{
  "comment": "A self-contained Markdown comment with the evidence-backed assessment, difficulty, relevant files, open questions, possible approach, and test seams that were useful. Omit empty sections."
}
</output>

Rules:

- `comment` is required and must be non-empty.
- Write for the future implementer; be concise but include concrete file paths
  and verified facts.
- Do not claim that you changed code or GitHub state — this was read-only.
- Emit nothing after the closing `</output>` tag.
