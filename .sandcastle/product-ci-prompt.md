## Product CI recovery contract

After producing commits and passing the repository's local checks, publish the
current automation branch only through `product-ci-cli.ts push` with the
workflow's `BRANCH` environment variable intact. Never override `BRANCH`: the
CLI binds the push to that automation branch, recognizes the initial head itself,
performs a plain non-force push, and accounts successful repair pushes. Create or
update only that branch's same-repository draft pull request against the stated
base. Initial branch publication and draft-PR creation consume no recovery
action.

Resolve the PR number after publication with `gh pr view --json number --jq .number`.
Run `pnpm --dir .sandcastle exec tsx product-ci-cli.ts wait --pr <number>` to
inspect and wait for the `CI` pull-request workflow's `Product` job. Success is
authoritative only for the exact live pull-request head and base. Missing, stale,
cancelled, unsuccessful, malformed, or unreadable evidence never counts as
success. Polling must print progress.

You may take at most two recovery actions in this active call. A successful push
of one or more repair commits is one action; an accepted no-code rerun request is
one action. Diagnosis, local edits, local checks, commits not yet pushed, initial
publication, and draft-PR upsert consume zero. Never invoke `git push` directly.
Request reruns with `product-ci-cli.ts rerun --pr <number> --run <run-id>`. The
CLI revalidates the current PR/head/base before accepting one.

Only repair failures plausibly introduced by this work and safely within its
specification. An unrelated base failure, unclear repair, merge conflict, needed
base update, exhausted budget, or timeout must stop with a concise reason and the
Product CI run URL so the workflow can mark the subject `agent:blocked`.

Your GitHub authority is narrow: push only the current automation branch; create
or update only its own draft PR; inspect/wait for Product CI; and rerun its current
Product CI. Do not mutate issues, labels, reviews, comments, threads, ready state,
child state, or merge state. Pull requests remain human-merged.
