# TASK

Write the title and description for a pull request that closes issue
#{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}.

The implementation is already done — the commits sit on branch `{{BRANCH}}`. You
are **not** implementing anything and **not** running tests. You are summarising
work that already exists.

# CONTEXT

Read the issue:

```
gh issue view {{ISSUE_NUMBER}} --comments
```

Read what changed on the branch:

```
git log {{BASE_BRANCH}}..{{BRANCH}} --reverse
git diff {{BASE_BRANCH}}..{{BRANCH}} --stat
git diff {{BASE_BRANCH}}..{{BRANCH}}
```

If the diff is large, lean on the commit messages and the `--stat` summary; only
`git diff` a specific file when a commit message is unclear.

Draft the title and description from what you read.

# OUTPUT

Once you have read everything, emit a single `<output>` block as the **last
thing** in your response:

<output>
{
  "prTitle": "feat: short imperative summary",
  "prDescription": "## Summary\n\n- what changed, in a few bullets\n\n## Notes for the reviewer\n\n- anything worth flagging\n\nCloses #{{ISSUE_NUMBER}}"
}
</output>

- `prTitle` — a single line, conventional-commit style (`feat:`, `fix:`,
  `refactor:`, `test:`, `docs:`), under 70 characters.
- `prDescription` — Markdown, and it **must** contain `Closes #{{ISSUE_NUMBER}}`
  so the PR closes the issue on merge.
