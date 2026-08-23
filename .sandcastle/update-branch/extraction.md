# EMIT THE UPDATE OUTCOME

You have finished trying to merge the base branch into the PR branch. Now emit that outcome
as **exactly one** `<output>` JSON block, as the last thing in your response. Do
not merge or change anything further — only serialise what already happened.

The block must match this shape:

<output>
{
  "outcome": "merged",
  "summary": "one-line headline: what happened and how many conflicts were resolved",
  "conflicts": [
    {
      "file": "apps/web/src/trail/geometry.ts",
      "resolution": "how you reconciled the two sides — which side won, or how they were combined"
    }
  ],
  "reason": "only when outcome is blocked: why a human is needed"
}
</output>

Rules:

- `outcome` — one of:
  - `"merged"` — you merged the remote base in, resolved the conflicts, validated
    the tree, and **committed** the merge.
  - `"already-current"` — the base merge reported *Already up to date*
    and you made **no** commit. (Unusual here — the branch was known to conflict.)
  - `"blocked"` — you aborted the merge (`git merge --abort`) because a conflict
    needs a human or the merged tree could not be made to build. The branch is
    left untouched.
- `summary` — required, one line, for every outcome.
- `conflicts` — one entry per file you resolved a conflict in. Use `[]` for
  `already-current`; it **must** be `[]` for `blocked` (an aborted merge resolved
  nothing) and for `already-current` (a no-op merged nothing). `file` and
  `resolution` are both required and non-empty.
- `reason` — **required when `outcome` is `blocked`**: a clear explanation a human
  can act on (which conflict, why you could not resolve it safely). Omit it
  otherwise.

Be honest: the runner independently verifies a `merged`/`already-current` claim
against the real git state (the base must be an ancestor of HEAD, no unresolved
paths remain, and HEAD must have advanced for `merged`), and fails the run if the
claim does not hold. A `blocked` outcome is the correct, expected way to hand a
hard merge back to a human — prefer it to a guessed resolution.

Emit nothing after the closing `</output>` tag.
