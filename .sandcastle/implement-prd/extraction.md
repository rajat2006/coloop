# REPORT THE OUTCOME

You have finished working on this sub-issue. Now emit your outcome as **exactly
one** `<output>` JSON block, as the last thing in your response. Do not implement
or change anything further — only report what already happened.

<output>
{
  "outcome": "completed",
  "reason": "one line: what you did this run, or why you could not finish"
}
</output>

Rules:

- `outcome` — exactly one of:
  - `"completed"` — you implemented the sub-issue in **this** run and committed
    the work.
  - `"already-satisfied"` — the sub-issue was already fully implemented by an
    earlier run, so you correctly made **no** new commits.
  - `"blocked"` — you could **not** complete it (ambiguous, needs a decision, or
    needs a human) and made no commits. A human will pick it up.
- `reason` — required, one line.

Do **not** mark `"completed"` unless you actually committed work this run. If you
are unsure or stuck, use `"blocked"`.

Emit nothing after the closing `</output>` tag.
