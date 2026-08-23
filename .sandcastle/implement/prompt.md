# TASK

Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are already on branch `{{BRANCH}}`, cut from `{{BASE_BRANCH}}`. Pull the issue in full,
including comments and any parent it references:

```
gh issue view {{ISSUE_NUMBER}} --comments
```

# CONTEXT

Before writing any code, read `CONTEXT.md` and the relevant ADRs under
`docs/adr/` — they carry the domain model and the decisions you must not
contradict. Then explore the parts of the repo this issue touches, especially
the test files around the code you will change.

# EXECUTION

Drive the repo's own skills — do not improvise a workflow:

- Follow the **`/implement`** skill (`.agents/skills/implement/SKILL.md`) to work
  the issue.
- Follow **`/tdd`** (`.agents/skills/tdd/SKILL.md`) at every seam it calls for:
  write a failing test, make it pass, repeat, then refactor.

Validate before you commit — both run through turbo:

```
pnpm run typecheck
pnpm run test
```

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional-commit messages
(`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

Commit locally before entering the publication and Product CI phase below. Do
not edit labels, comments, review state, or the issue, and do **not** close it.
The draft PR body must contain `Closes #{{ISSUE_NUMBER}}` so a blocked retry can
unambiguously resume the automation-owned PR.

<!-- PRODUCT_CI_RECOVERY -->

If you cannot complete the work — the issue is ambiguous, blocked on a decision,
or needs a human — stop and explain why in your final message instead of
committing a half-finished change. Leaving the branch with no commits is the
correct signal for "a human needs to look at this"; the workflow will mark the
issue blocked. Once you have published a draft PR, leave it in place when blocked.
