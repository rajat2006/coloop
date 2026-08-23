# TASK

You are implementing **one sub-issue** of a multi-run PRD.

- **PRD:** #{{PRD_NUMBER}} — {{PRD_TITLE}}
- **This sub-issue:** #{{SUB_ISSUE_NUMBER}} — {{SUB_ISSUE_TITLE}}
- **Branch:** `{{BRANCH}}`

The branch may already carry commits from earlier sub-issues. Do **not** rebase
or rewrite that history — add your work on top.

Pull both issues in for context:

```
gh issue view {{PRD_NUMBER}} --comments
gh issue view {{SUB_ISSUE_NUMBER}} --comments
```

You also have the full list of sibling sub-issues, to understand what has already
shipped on this branch and what is still ahead:

```
gh api "repos/$GH_REPO/issues/{{PRD_NUMBER}}/sub_issues"
```

Your implementation of #{{SUB_ISSUE_NUMBER}} must fit the larger PRD plan — but
**only implement #{{SUB_ISSUE_NUMBER}}** in this run. Do not do work that belongs
to a different sub-issue.

# CONTEXT

Before writing any code, read `CONTEXT.md` and the relevant ADRs under
`docs/adr/` — they carry the domain model and the decisions you must not
contradict. Then explore the parts of the repo this sub-issue touches, especially
the test files around the code you will change.

# EXECUTION

Drive the repo's own skills — do not improvise a workflow:

- Follow the **`/implement`** skill (`.agents/skills/implement/SKILL.md`) to work
  the sub-issue.
- Follow **`/tdd`** (`.agents/skills/tdd/SKILL.md`) at every seam it calls for:
  write a failing test, make it pass, repeat, then refactor.

Validate before you commit:

```
pnpm run typecheck
pnpm run test
```

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional-commit messages
(`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Include `Part of #{{PRD_NUMBER}}`
in each commit body so the history is linkable from the PRD. Do **not** put
`Closes` in a commit message — closing the sub-issue is the workflow's job, and
closing the PRD is the merged PR's job.

Commit locally before entering the publication and Product CI phase below. Do
not edit labels or comments, and do not close the sub-issue or PRD.
The draft PR body must contain `Closes #{{PRD_NUMBER}}`; it closes the PRD only
when a human eventually merges it, never during this run.

<!-- PRODUCT_CI_RECOVERY -->

# WHEN YOU FINISH

After the work, you'll be asked to report the outcome. Reason in prose now and
end your message by clearly stating which of these applies — do **not** emit any
JSON yet:

- **Completed** — you implemented #{{SUB_ISSUE_NUMBER}} in this run and committed
  the work.
- **Already satisfied** — the sub-issue was already fully implemented by an
  earlier run, you made no new commits, and the existing draft PR head is green.
  A first-child run with no existing PR cannot use this outcome.
- **Blocked** — you could **not** complete it (it is ambiguous, blocked on a
  decision, or needs a human). Do **not** force a half-finished commit: leave the
  branch untouched and explain why. A human will pick it up.
