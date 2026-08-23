# EMIT THE REVIEW FINDINGS

You have finished reviewing the branch, applied the fixes you could, committed
them, and re-reviewed. Now emit your findings as **exactly one** `<output>` JSON
block, as the last thing in your response. Do not review or change anything
further — only serialise the findings you already have.

The block must match this shape:

<output>
{
  "summary": "one-line headline: total findings, how many auto-fixed, worst unresolved per axis",
  "findings": [
    {
      "axis": "standards",
      "severity": "high",
      "status": "fixed",
      "file": "apps/web/src/trail/geometry.ts",
      "line": 42,
      "title": "short imperative title",
      "detail": "what was wrong and — for a fix — what you changed; for unresolved, how a human should fix it"
    }
  ]
}
</output>

Rules:

- `summary` — required, one line. Even for a clean review (e.g. `"No standards or
  spec findings; branch is clean."`).
- `findings` — an array. Use `[]` when the branch is clean; otherwise one entry
  per finding from **both** axes, including the ones you fixed.
- `axis` — `"standards"` or `"spec"`.
- `severity` — one of `"blocking"`, `"high"`, `"medium"`, `"low"`, `"nit"`.
- `status` — `"fixed"` if you edited the code and committed a fix for it, or
  `"unresolved"` if you left it for a human. Be honest: only mark `fixed` what you
  actually committed.
- `file` — the repo-relative path (e.g. `apps/web/src/trail/geometry.ts`).
- `line` — the **new-side** line number in the post-fix base-branch diff
  diff, for an `unresolved` finding about a specific line (that is where its
  inline comment anchors). **Omit `line` entirely** for a file- or change-level
  finding, and you may omit it for `fixed` findings. Never guess a number —
  anchors are cross-checked against the real diff, and a line that isn't in the
  diff is dropped to a summary note.
- `title` / `detail` — both required and non-empty.

Emit nothing after the closing `</output>` tag.
