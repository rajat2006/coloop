# TASK

Write the title and description for a pull request that delivers PRD
#{{PRD_NUMBER}}: {{PRD_TITLE}}.

The PRD ships as a chain of sub-issue runs, all committing to the same branch.
This PR is reused across every sub-issue run, so the title and description must
describe the **whole PRD**, not any individual sub-issue. You are **not**
implementing anything and **not** running tests.

# CONTEXT

Read the PRD and enumerate its sub-issues:

```
gh issue view {{PRD_NUMBER}} --comments
gh api "repos/$GH_REPO/issues/{{PRD_NUMBER}}/sub_issues"
```

Draft the title and description, framed around the whole PRD.

# OUTPUT

Once you have read everything, emit a single `<output>` block as the **last
thing** in your response:

<output>
{
  "prTitle": "feat: short imperative summary of the PRD as a whole",
  "prDescription": "## Summary\n\nWhat the PRD delivers, in 1–3 paragraphs framed around the whole effort.\n\n## Sub-issues\n\n- #N — title\n- #M — title\n\nCloses #{{PRD_NUMBER}}"
}
</output>

- `prTitle` — a single line, under 70 characters, conventional-commit style
  (`feat:`, `fix:`, `refactor:`, `docs:`), framed around the PRD as a whole.
- `prDescription` — Markdown. It must restate the PRD's overall intent, list
  every sub-issue with its number and title, and end with `Closes #{{PRD_NUMBER}}`
  so the PR closes the PRD on merge. Do **not** add `Closes` lines for individual
  sub-issues — the workflow closes each sub-issue as its run completes.
