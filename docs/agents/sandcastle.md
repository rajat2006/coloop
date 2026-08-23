# Sandcastle autonomous-agent platform — operations

The `.sandcastle/` runner seam and `.github/workflows/agent-*.yml` workflows let
autonomous coding agents work ready issues into reviewed draft PRs inside GitHub
Actions. This doc is the operator's control surface: the `agent:*` label taxonomy
and the one-time secrets provisioning checklist. This setup is ported from
Unshelf; the runner seam is documented in
[`.sandcastle/README.md`](../../.sandcastle/README.md).

The maintainer's only two touch-points are **applying the trigger label** and
**merging**. Everything between is machine-driven.

## Label taxonomy

Four orthogonal layers. Triage and wayfinder labels are unchanged
(see [`triage-labels.md`](triage-labels.md)).

### 1. Triage (existing)

`ready-for-agent` marks fully-specified work safe to hand to an agent — it is **not
a trigger**, just a signal. `ready-for-human` is **human-applied only** and pulls an
issue out of the agent lane; it is never applied by a machine.

### 2. Provider

| Label | Meaning |
| --- | --- |
| `agent:claude` | Optional **provider pin**: run this subject on Claude Code. |
| `agent:codex` | Optional **provider pin**: run this subject on Codex. |

**Neither label present ⇒ `DEFAULT_PROVIDER`** in `.sandcastle/resolve-agent.ts` — the one
constant to flip (`"claude"` ⇄ `"codex"`) when the subscription changes; it moves every
capability and every workflow at once. Both labels present is ambiguous and also falls
back to the default. `resolveProvider()` is the single source of truth: the runners call
it directly, and the workflows read it through `.sandcastle/print-provider.ts` (the
`Resolve provider` step) so their provider-specific setup — installing the Codex CLI,
propagating the provider label — can never drift from it.

A provider label selects the provider **only**; the **model and reasoning effort are
chosen per capability** by the policy in `.sandcastle/resolve-agent.ts` (issue #88) — a
Build-tier capability runs Claude on `claude-opus-4-8`/`medium` (Codex
`gpt-5.6-sol`/`medium`), a Think-tier capability runs Claude on `claude-fable-5` at
`medium` or `high` (Codex `gpt-5.6-sol` at `medium` or `xhigh`).

`agent-implement` / `agent-implement-prd` **propagate the resolved provider label onto the
PR** they open (always explicitly — `agent:claude` or `agent:codex`), so the review runs on
the same provider that wrote the branch even if `DEFAULT_PROVIDER` is flipped in between.
Each workflow otherwise resolves its provider from its own subject's label set.

### 3. Agent state machine

| Label | Applied by | Meaning |
| --- | --- | --- |
| `agent:implement` | **human** | Trigger on an issue → the workflow removes it and adds `agent:in-progress`. |
| `agent:in-progress` | machine | A run is active. Added on start, removed on finish (`if: always()`). |
| `agent:review` | machine (via `AGENT_PAT`) | An implement run finished → fires the review workflow. |
| `agent:implement-pr` | human | Address review comments on an open PR. |
| `agent:update-branch` | human | Refresh a stale PR branch against its base. |
| `agent:to-issues` | human | Expand a PRD issue into child issues. |
| `agent:explore` | human | Investigate one issue read-only and post an implementation assessment. |
| `agent:queued` | machine | Blocked by another open issue; `promote-queued` flips it to `agent:implement` when the blocker closes. |
| `agent:blocked` | machine | A run stopped (crash, timeout, or the agent explicitly asked for a human). Carries a run-URL comment. |

**Why machine label-adds use `AGENT_PAT`:** a label applied by the default
`GITHUB_TOKEN` does not trigger a downstream workflow. The implement → review → ready
chain only fires because `agent:review` is added with the PAT (see secrets below).

**Retry is manual.** Any stop lands the subject in `agent:blocked` with a run link. A
human clears `agent:blocked` and re-applies the **originating trigger label** (the one
that fired the run — `agent:implement`, `agent:implement-pr`, `agent:update-branch`,
`agent:to-issues`, or `agent:explore`) to retry — there is no automatic loop. (Sandcastle's within-run
resume-session retry is internal to a single run, not a label transition.)

### 4. Provenance

`source:architecture-review` (machine) marks a PRD **proposed by the scheduled
`agent-architecture-review`** run — not a trigger. It is the dedupe key each run
checks (so it never re-raises an open opportunity) and the backlog the open-proposal
cap counts (ten open ⇒ the next run skips). A human triages it like any PRD, then
applies `agent:to-issues` to expand it.

### Provisioning the labels

Idempotent — creates or reconciles the eleven `agent:*` labels plus the
`source:architecture-review` provenance label (spec #70), touching nothing else:

```bash
./.sandcastle/provision-labels.sh            # current repo
./.sandcastle/provision-labels.sh owner/repo # explicit repo
```

## Secrets provisioning checklist

Both providers authenticate via **flat subscription seats, not metered API keys**, so
marginal per-issue agent cost is ~$0 — the only metered cost is Actions minutes. Create
these **three** repository secrets once
(`Settings → Secrets and variables → Actions → New repository secret`):

### 1. `CLAUDE_CODE_OAUTH_TOKEN`

Mint from a Claude Pro/Max seat and paste the token as the secret value:

```bash
claude setup-token
```

The workflow feeds it to the same-named env var; the runner's `@anthropic-ai/claude-code`
picks it up. This is CVM's proven path.

### 2. `CODEX_AUTH_JSON`

The **contents** of `~/.codex/auth.json` produced by a local `codex login` (Codex uses a
file-based credential store, not an API key). The workflow materialises it into
`$CODEX_HOME/auth.json` on the runner **before** `sandcastle.run()` — Sandcastle fails
fast if `auth.json` is missing.

```bash
codex login            # once, locally
cat ~/.codex/auth.json # paste the whole file as the secret value
```

**Codex CI requirements — read before wiring the Codex path:**

- `~/.codex/config.toml` must set `cli_auth_credentials_store = "file"` — the OS keyring
  is unreachable in CI. The runner writes this automatically (`prepareCodexAuth`).
- **`OPENAI_KEY` / `OPENAI_API_KEY` must NOT be set** anywhere the runner can see them. If
  either is present, Codex bills against the metered Platform API and can fail
  `Quota exceeded` even with a valid subscription. Do not add them as secrets.
- **The secret needs a periodic (~weekly) re-paste.** Codex refreshes the ChatGPT
  tokens *in place* during a run, and its refresh token is **single-use** (rotated on
  every refresh, with server-side reuse detection — see
  [`codex-rs/login/src/auth/manager.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)).
  Within a job the runner seeds `auth.json` only when it is **absent**, so a later phase
  never restores the stale seed over a fresh refresh. But an ephemeral runner discards
  the refreshed file at job end — so once a run actually refreshes, the copy still in
  `CODEX_AUTH_JSON` is burned. A run only refreshes when the seeded access token is near
  expiry, which is on the order of **~8 days** (codex's `TOKEN_REFRESH_INTERVAL`; OpenAI
  recommends a [weekly maintenance schedule](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).
  So a pasted secret runs cleanly for about a week, then a codex run fails with
  *"refresh token was already used"* — at which point re-run `codex login` and repaste
  `CODEX_AUTH_JSON`. Fully hands-off operation (writing the refreshed `auth.json` back to
  the secret + serialising codex runs) is deferred to a follow-up. This lifecycle is
  Codex-only — Claude Code authenticates from `CLAUDE_CODE_OAUTH_TOKEN` and has none of
  it — so the re-paste cadence bites only to the extent that runs actually resolve to
  Codex (every run — `DEFAULT_PROVIDER` is `"codex"`).

### 3. `AGENT_PAT`

A **fine-grained personal access token**, scoped to this repo, with:

- **Contents** — Read and write
- **Pull requests** — Read and write
- **Actions** — Read and write
- **Workflows** — Read and write

Needed because the default `GITHUB_TOKEN` lacks the `workflows` scope and cannot trigger a
downstream workflow when it adds a label — so the implement → review → ready chain would
stall without it. It is also the preferred checkout token (`fetch-depth: 0`), falling back
to `GITHUB_TOKEN` when absent.

It is likewise what opens the draft PRs. `gh pr create` under `GITHUB_TOKEN` is gated by the
repo's **Settings → Actions → General → "Allow GitHub Actions to create and approve pull
requests"** checkbox, which is **off by default** — with it off the run dies on
*"GitHub Actions is not permitted to create or approve pull requests (createPullRequest)"*
no matter what the job's `permissions:` block grants. A PAT is not subject to that policy,
and the PR it opens can trigger downstream workflows. The productive Implement,
Implement PRD, Review, and Implement-PR calls receive this token only for their
narrow current-branch/draft-PR/Product-CI path. Actions write is required to
discover jobs and request an accepted no-code Product CI rerun.

## Product CI recovery

The four productive capabilities share one 120-minute outer timeout and one
prompt contract. After local checks they plain-push their current automation
branch, create or update its same-repository draft PR, and wait for the `CI`
pull-request workflow's `Product` job. Proof is valid only when the run is
associated with the live PR and records its exact current head and base SHAs.
Every workflow rechecks that proof against fresh PR state immediately before a
protected lifecycle or publication mutation.

Initial publication costs no recovery action. A successfully pushed repair head
or accepted no-code rerun costs one, with at most two in the active call. Local
diagnosis, edits, checks, and unpublished commits cost none. Stale, missing,
cancelled, unsuccessful, malformed, unreadable, or timed-out evidence fails
closed. Unrelated base failures, ambiguous fixes, merge conflicts, and required
base updates also stop recovery. The existing `agent:blocked` comment records the
reason and run URL; retry is manual. Leaf retries resume only one matching open
same-repo draft PR on the deterministic branch/base and never force-push.
Agents publish only through the shared Product CI CLI: it refuses a third repair
before pushing and records the action only after a successful push.

This exception does not grant lifecycle authority: agents cannot change issues,
labels, reviews, comments, threads, child state, ready state, merge state, or
other branches. Pull requests remain human-merged.

### `GITHUB_TOKEN` (auto-provided — do not create)

GitHub injects this automatically. It is only the checkout fallback when `AGENT_PAT` is
absent, and it is deliberately **not** used for chain-triggering label adds.

### Not used — and one that must stay unset

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` / `OPENAI_KEY` are **not** part of this setup
(subscription auth replaces them). As above, setting `OPENAI_KEY`/`OPENAI_API_KEY` actively
breaks the Codex subscription path — leave them unset.

## Workflows

Each capability is one `.github/workflows/agent-*.yml` on top of the `.sandcastle/`
seam; the runner-side scripts + prompts are documented in
[`.sandcastle/README.md`](../../.sandcastle/README.md).

| Workflow | Trigger | Does |
| --- | --- | --- |
| `agent-implement.yml` | `agent:implement` on a leaf issue | Cuts or safely resumes `agent/issue-<N>-<slug>`, runs Implement through draft publication and exact-candidate Product CI recovery, reconciles metadata/provider state, gates the live head again, then adds `agent:review`. A blocked retry accepts only one matching open same-repo draft PR for the deterministic branch/base and never rewrites history. PRD/parent-shape routing still fails closed. |
| `agent-implement-prd.yml` | `agent:implement` on a **PRD-shaped** issue | Processes one child on the accumulating non-force branch. The productive call ensures the draft PR exists and is green before returning; the workflow gates again before closing the child and again before chaining or Review handoff. `already-satisfied` advances only with an existing green PR, while a CI repair commit is `completed`. Shape and nesting checks remain fail-closed. |
| `agent-review.yml` | `agent:review` on a PR (`pull_request_target`) | Reviews, safely fixes, publishes, recovers Product CI, and regenerates findings after any repair commit. The workflow binds output to the inspected head and live-gates Product CI before posting the review and before marking ready. Failures remain draft and blocked; fork and per-PR concurrency protections remain unchanged. |
| `agent-architecture-review.yml` | weekday cron (09:00 UTC) + `workflow_dispatch` (**no label**) | The autonomous analogue of CVM's interactive `/improve-codebase-architecture`. Checks out the repository's default branch and runs the `architecture-review` capability to survey the tree for the **single freshest deepening opportunity** and propose it as a **PRD** labelled `source:architecture-review` (a human later expands it with `agent:to-issues`). Does **not** run the interactive `/improve-codebase-architecture` skill — it's `disable-model-invocation` and needs an HTML report + a human; the survey is described directly with the `/codebase-design` vocabulary. Read-only — the agent commits nothing (`permissions: contents: read`). Before running it **dedupes** against **open *and closed*** `source:architecture-review` proposals (their titles are fed to the agent so it never re-raises a completed or rejected idea) and **skips the run entirely once ten are open**, so an un-triaged backlog doesn't grow. One PRD per run (or a `skipped` no-op), and it **always writes an Actions run summary** — the created PRD + candidates considered, the skip reason, or the backlog-full outcome. A manual dispatch can pin either provider via the `provider` input; its `default` option (and the cron path, which sends no input) resolves to `DEFAULT_PROVIDER` like every other flow. Serialised by a single concurrency group (`cancel-in-progress: false`). |
| `agent-implement-pr.yml` | `agent:implement-pr` on an **open** PR (`pull_request_target`) | Addresses feedback, publishes fixes, recovers Product CI, then regenerates replies/summary against the green head. The workflow checks the expected head, refreshes the unresolved-thread allowlist, and live-gates before replies and the summary. It never changes draft/ready state; existing refusal, blocked, and concurrency behavior remains. |
| `agent-update-branch.yml` | `agent:update-branch` on a PR (`pull_request_target`) | Brings a stale or conflicted branch current with its PR base. Resolves the common cases **deterministically, no agent**: an already-current branch is a no-op, and a conflict-free merge is done with `git merge` in a shell step (matching CVM — the agent is spent only when there are real conflicts). On a conflicted merge it runs the `update-branch` capability, which re-merges, resolves the conflicts, runs the repo's checks, and **commits the merge**; the runner then cross-checks the agent's claim against the real git state (the remote base is now an ancestor of HEAD, HEAD advanced, no unresolved paths, no lingering merge state) before the workflow pushes. The workflow pushes the refreshed branch (a plain, non-force push — merge, never rebase) and posts a summary comment. Fires on the labeled event even when the PR head **conflicts with base** — `pull_request_target` is not gated on mergeability, which is the whole point. Swaps `agent:update-branch` → `agent:in-progress` on start; a failure — a failed postcondition, or an agent that reports `blocked` because a conflict needs a human — lands the PR in `agent:blocked` with the reason and a run-URL comment (the branch is left unchanged — the merge is only pushed on success) and always removes `agent:in-progress`. Shares the per-PR concurrency group with the other PR-mutating capabilities (`queue: max`, `cancel-in-progress: false`). Fork PRs are refused. |
| `agent-to-issues.yml` | `agent:to-issues` on a PRD issue | Runs the `to-issues-prd` capability (the agent reads the PRD and emits a **structured** decomposition; it creates nothing), the runner deterministically renders each child's body, then the **workflow** does the `gh issue create` for each child and links it as a sub-issue of the PRD — a **failed link fails the run** (no orphaned, unlinked child reported as done). Swaps `agent:to-issues` → `agent:in-progress` on start; comments the created sub-issue list (in build order) on the PRD on success; a failure lands the PRD in `agent:blocked` with a run-URL comment that **inventories any children already created** and says to detach them before retrying, and always removes `agent:in-progress`. The parent PRD is never closed and its body is never edited. Refuses (with `agent:blocked`) a sub-issue (a leaf, not a PRD) and a PRD that already has sub-issues (already decomposed). Applies **no** state label to the children — a human triages them. Per-PRD concurrency (`queue: max`, `cancel-in-progress: false`). |
| `agent-explore.yml` | `agent:explore` on an issue | Runs the read-only `explore` capability against the repository's default branch to verify the issue's claims, estimate difficulty, identify relevant files and open questions, sketch an implementation approach, and name useful test seams. The workflow fetches the issue context, then withholds GitHub credentials from the agent; the runner rejects a changed `HEAD` or dirty worktree and emits only `comment.md`, which the workflow posts. It uses the issue's full label set, so provider routing (`agent:claude` / `agent:codex`, else the default) and subscription auth match every other capability. Swaps `agent:explore` → `agent:in-progress` on start; a failure lands the issue in `agent:blocked` with a run-URL comment, and `agent:in-progress` is always removed. Per-issue concurrency queues rather than cancels. No branch, commit, or PR is produced. |
| `agent-promote-queued.yml` | An issue closing (`issues: closed`) | **Pure label automation — no runner, no checkout; `gh` + `jq` only.** When an issue closes **as completed** (`not_planned` closures promote nothing), finds every **open** dependent it was blocking (GitHub native issue dependencies) and flips each waiting `agent:queued` issue to `agent:implement` via `AGENT_PAT`, so the promotion chains straight into `agent-implement` and comments the unblock on the issue. Promotes only when the dependent is still `agent:queued`, is not `agent:in-progress` or `ready-for-human`, is not a sub-issue (a queued sub-issue is refused into `agent:blocked` with a comment, like `agent-implement`), and has **no other open blocker** — a dependent with a second unmet blocker stays `agent:queued`. Every `gh` lookup **fails closed** (an API error leaves the dependent queued, never wrongly promoted). No concurrency group: a final `agent:queued` re-read immediately before the mutation serialises two blockers of the same dependent closing at once. |

## Cost model

The provider seats are flat subscriptions and GitHub Actions minutes may still be
metered according to this repository's plan. The four Product-CI-owning
capabilities allow 120 minutes so polling and bounded recovery stay in the active
call; other agent jobs retain their existing ceilings.
