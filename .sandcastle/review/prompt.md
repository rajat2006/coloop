# TASK

Review the changes on branch `{{BRANCH}}` — the branch implementing issue
#{{ISSUE_NUMBER}}: {{ISSUE_TITLE}} — using **this repo's own `/code-review`
skill**, **fix what you safely can**, and re-review the result.

Use only the local `/code-review` skill defined in this repository
(`.agents/skills/code-review/`). Do not use any external or third-party review
skill.

# CONTEXT

The fixed point for the review is the mainline the branch was cut from:

```
origin/{{BASE_BRANCH}}
```

So the diff under review is:

```
git diff origin/{{BASE_BRANCH}}...HEAD
git log origin/{{BASE_BRANCH}}..HEAD --oneline
```

(Three-dot diff, against the merge-base — the same form `/code-review` expects.)

The originating spec is issue #{{ISSUE_NUMBER}}. Read it, and follow any spec
references in the commit messages:

```
gh issue view {{ISSUE_NUMBER}} --comments
```

Also read `CONTEXT.md` and any relevant `docs/adr/` for the domain rules the
Standards axis should hold the change to.

# LIFECYCLE

Work in this order:

### 1. Review

Run the `/code-review` skill with `origin/{{BASE_BRANCH}}` as the fixed point. It reviews
along both axes in parallel sub-agents and reports them separately:

- **Standards** — does the code follow this repo's documented coding standards
  (plus the skill's smell baseline)?
- **Spec** — does the change faithfully implement issue #{{ISSUE_NUMBER}}: are any
  requirements missing or partial, is there scope creep, is anything implemented
  but wrong?

### 2. Fix what you safely can

For each finding, decide: can you fix it correctly and in scope, right now,
without guessing at intent? If yes, **edit the code and fix it**. If it is risky,
ambiguous, needs a product decision, or would balloon the change, **leave it for
a human** — do not force a speculative fix.

Keep fixes tight and on-topic for the finding. Run the repo's checks on what you
touch:

```
pnpm run typecheck
pnpm run test
```

Do not break the build. If a fix would fail typecheck/test and you can't make it
pass cleanly, revert that fix and leave the finding unresolved instead.

### 3. Commit your fixes

Commit the fixes you made in focused commits with clear messages (e.g.
`Fix review finding: extract duplicated distance calc`). Do not touch PR labels,
comments, review state, or threads.

If you fixed nothing (the branch was already clean, or every finding was left for
a human), make no commits.

### 4. Publish and prove Product CI

<!-- PRODUCT_CI_RECOVERY -->

### 5. Re-review the green head

Re-diff after your commits:

```
git diff origin/{{BASE_BRANCH}}...HEAD
```

Confirm your fixes actually resolved the findings they targeted and did not
introduce anything new (a fix that trips another smell is itself a finding).
Any commit made during Product CI recovery invalidates the earlier review, so
regenerate the complete findings against the resulting green head.

# REPORTING

Reason in prose throughout — do **not** emit any JSON or `<output>` block yet. A
separate follow-up turn will ask you to emit the structured findings, where each
finding is marked either `fixed` (you edited + committed it) or `unresolved`
(left for a human). For `unresolved` findings about a specific line, note the
**new-side line number in the post-fix diff**, since that is what an inline PR
comment will anchor to.

If the change is clean on an axis, say so — an axis with no findings is a valid
outcome.
