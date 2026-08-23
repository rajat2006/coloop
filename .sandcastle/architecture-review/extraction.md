# EMIT THE ARCHITECTURE-REVIEW DECISION

You have finished surveying the codebase. Now emit your decision as **exactly
one** `<output>` JSON block, as the last thing in your response. Do not survey or
change anything further — only serialise the decision you already reached.

The block must match **one** of these two shapes exactly — no extra fields.

**Proposed** — you found one fresh deepening opportunity and wrote it up:

<output>
{
  "status": "proposed",
  "oneLineSummary": "one-line headline of the deepening you are proposing",
  "title": "PRD title — imperative, ≤256 chars, names the module and the deepening",
  "body": "The full PRD as Markdown, with ALL of these sections in order: ## Problem Statement / ## Solution / ## User Stories / ## Implementation Decisions / ## Testing Decisions / ## Out of Scope / ## Further Notes. Use /codebase-design and CONTEXT.md vocabulary; reference modules and ADRs by name.",
  "candidatesConsidered": ["short label of each deepening candidate you seriously weighed, including the one you chose"]
}
</output>

**Skipped** — nothing fresh worth proposing this run:

<output>
{
  "status": "skipped",
  "reason": "one line: why nothing was proposed (clean on this axis, or every candidate already proposed)"
}
</output>

Rules:

- `status` — `"proposed"` or `"skipped"`.
- The block is validated as a **strict discriminated union**: emit **only** the
  fields shown for the branch you chose. A stray field from the other branch is
  rejected and you'll be asked to fix it.
- `proposed` — `oneLineSummary`, `title`, `body`, `candidatesConsidered` all
  required. `title` ≤ 256 chars. `body` must contain all seven sections.
  `candidatesConsidered` must have **at least one non-empty** entry (the one you
  chose counts).
- `skipped` — **only** `status` + `reason` (a non-empty one-line reason). No
  `title`, `body`, `oneLineSummary`, or `candidatesConsidered`.
- Propose **at most one** opportunity — one PRD per run. Never bundle several.
- Emit nothing after the closing `</output>` tag.
