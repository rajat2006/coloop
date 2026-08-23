# TASK

Address the **review comments** on pull request #{{PR_NUMBER}} — the PR on branch
`{{BRANCH}}` implementing issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}. Change what you
safely can to satisfy each comment, run the repo's checks, and commit your fixes.

# CONTEXT

Read the review threads first — that is the work list. Fetch them via **GraphQL**,
which is the only API that exposes each thread's `isResolved` state (the REST
`/pulls/N/comments` endpoint does not), so you can reliably skip resolved threads:

```
repo=$(gh repo view --json owner,name -q '.owner.login + " " + .name')
set -- $repo   # $1=owner  $2=name
gh api graphql -f owner="$1" -f name="$2" -F pr={{PR_NUMBER}} -f query='
  query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$pr){
        reviewThreads(first:100){ nodes{
          id isResolved isOutdated path line
          comments(first:20){ nodes{ author{login} body } } } }
        reviews(first:50){ nodes{ author{login} state body } } } } }'
```

Also skim the human-readable view for top-level discussion:

```
gh pr view {{PR_NUMBER}} --comments
```

The branch targets `{{BASE_BRANCH}}`, so the change under review is:

```
git diff origin/{{BASE_BRANCH}}...HEAD
git log origin/{{BASE_BRANCH}}..HEAD --oneline
```

Read the originating spec and any references in the commit messages, so a fix
lands in line with what the issue actually asked for:

```
gh issue view {{ISSUE_NUMBER}} --comments
```

Also read `CONTEXT.md` and any relevant `docs/adr/` for the domain rules a fix
must respect.

# LIFECYCLE

Work in this order:

### 1. Collect the comments

Gather every actionable review comment — inline (file + line) and top-level.
Ignore resolved/outdated threads and pure approvals. For each, decide the
reviewer's actual ask. **Keep the `id` of each review thread you act on** —
whether you fix it or defer it — so you can report it and the workflow can reply
on that exact thread (with the fix, or with why you left it). The reviewer
resolves the thread once they've confirmed.

### 2. Address what you safely can

For each comment, decide: can you satisfy it correctly and in scope, right now,
without guessing at intent? If yes, **edit the code and fix it**. If it is risky,
ambiguous, needs a product decision, contradicts another comment, or you disagree
on technical grounds, **defer it for a human** — do not force a speculative or
argumentative change.

Keep each change tight and on-topic for the comment it answers. Run the repo's
checks on what you touch:

```
pnpm run typecheck
pnpm run test
```

Do not break the build. If a fix would fail typecheck/test and you can't make it
pass cleanly, revert that fix and defer the comment instead.

### 3. Commit your changes

Commit the fixes in focused commits with clear messages (e.g.
`Address review: extract duplicated distance calc`). Do not touch PR labels,
comments, review state, or threads.

If you addressed nothing (every comment was deferred), make no commits — that is a
valid outcome, and the summary will explain why.

### 4. Publish and prove Product CI

<!-- PRODUCT_CI_RECOVERY -->

### 5. Re-check the green head

Re-diff after your commits and confirm your changes actually resolve the comments
they targeted and introduce nothing new:

```
git diff origin/{{BASE_BRANCH}}...HEAD
```

Any commit made during Product CI recovery invalidates the earlier feedback
record. Re-read the unresolved review threads and regenerate the replies and
summary against the resulting green head before reporting.

# REPORTING

Reason in prose throughout — do **not** emit any JSON or `<output>` block yet. A
separate follow-up turn will ask you to emit the structured record, where each
comment is marked either `addressed` (you edited + committed a change for it) or
`deferred` (left for a human). Be honest: only mark `addressed` what you actually
committed.
