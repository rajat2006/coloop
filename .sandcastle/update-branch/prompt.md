# TASK

Bring branch `{{BRANCH}}` — the branch for issue #{{ISSUE_NUMBER}}:
{{ISSUE_TITLE}} — current with `{{BASE_BRANCH}}` by **merging `origin/{{BASE_BRANCH}}` into it** and
resolving the conflicts. This branch is **known to conflict** with `{{BASE_BRANCH}}`: the
workflow already tried a plain `git merge` deterministically, hit conflicts, and
aborted it before handing the job to you. Your job is to redo that merge and
resolve the conflicts so the branch merges cleanly again, without losing either
side's intent.

# CONTEXT

You are already on branch `{{BRANCH}}` (clean — the deterministic merge was
aborted), and `origin/{{BASE_BRANCH}}` has been fetched, so the base to merge in is:

```
origin/{{BASE_BRANCH}}
```

See what the branch adds over its base, and how far it has drifted:

```
git log origin/{{BASE_BRANCH}}..HEAD --oneline
git log HEAD..origin/{{BASE_BRANCH}} --oneline
git diff origin/{{BASE_BRANCH}}...HEAD --stat
```

Read the originating issue so a conflict resolution honours what the branch is
trying to do:

```
gh issue view {{ISSUE_NUMBER}} --comments
```

Also read `CONTEXT.md` and any relevant `docs/adr/` when a conflict touches a
domain rule — a resolution must not silently contradict a decision recorded
there.

# LIFECYCLE

Work in this order:

### 1. Merge the base branch in

```
git merge origin/{{BASE_BRANCH}}
```

**Merge — do not rebase.** The workflow pushes your branch with a plain
(non-force) push, so history must only ever grow: a rebase that rewrites the
branch's existing commits would be rejected on push.

### 2. Resolve every conflict

For each conflicted file, reconcile the two sides so **both** the branch's change
and the base branch's change are preserved wherever they don't genuinely contradict. When
they do contradict, keep the branch's intent (that is the work under review) but
carry over any mechanical change from the base it depends on (a rename, a moved
import, a changed signature). Never resolve a conflict by blindly discarding one
side, and never leave conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in a
file.

**Never hand-resolve a conflict under `drizzle/meta/`.** That directory is
generated migration bookkeeping, and a keep-both-sides merge produces a
plausible-looking file with duplicate ordinals — a broken migration history that
reports no error. Discard this branch's migration and regenerate it on top of
the base instead, or report `blocked` if you cannot.

If a conflict needs a product decision you cannot make safely, **stop** — abort
the merge (`git merge --abort`) and report `blocked` (see REPORTING) with a clear
reason. That is the correct "a human needs to look at this" signal; the workflow
marks the PR blocked with your reason and leaves the branch untouched. Do **not**
guess a resolution just to finish.

### 3. Validate

Run the repo's checks and make sure the merged tree still builds and passes:

```
pnpm run typecheck
pnpm run test
```

If the merge left the build broken and you cannot fix it cleanly and in scope,
abort the merge and report `blocked` (as above) — do not commit a broken merge.

### 4. Commit the merge

Complete the merge commit (`git commit` with the default merge message is fine,
or `git commit -m "Merge {{BASE_BRANCH}} into {{BRANCH}}"`). If you had to hand-edit files
to resolve conflicts, `git add` them first.

**Commit only — do not push, do not force, do not rebase, and do not touch PR
labels, comments, or `gh` state.** The workflow pushes your branch and posts the
summary; your job is the merge commit and the report. The runner independently
re-checks the git state after you finish (origin/{{BASE_BRANCH}} must be an ancestor of
HEAD, HEAD must have advanced, no unresolved paths, not mid-merge), so an aborted
or half-finished merge cannot be reported as success — report honestly.

# REPORTING

Reason in prose throughout — do **not** emit any JSON or `<output>` block yet. A
separate follow-up turn will ask you to emit the structured outcome: whether you
`merged` (with one entry per conflict you resolved), found the branch
`already-current` (only if `git merge` reported *Already up to date* and you made
no commit), or `blocked` it for a human (with the reason).
