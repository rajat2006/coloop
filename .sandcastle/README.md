# `.sandcastle/` — autonomous-agent runner seam

Dev infrastructure, **not a product workspace**. This is the foundation for
running coding agents autonomously in GitHub Actions via
[Sandcastle](https://github.com/mattpocock/sandcastle). It joins the pnpm
workspace as its own project, and the root `test` / `typecheck` scripts cover it.

## The testable seam

The control flow around `sandcastle.run()`, extracted so it is unit-testable by
mocking `run()` — no database, no network, no real agent. Ported from
course-video-manager's runner (the Sandcastle reference), reconciled to the
pinned Sandcastle version and this repository's provider set:

- **`run-with-retry.ts`** — `runWithRetry`: a single call that both does the work
  and emits structured `output`, retrying the *same session* on a
  `StructuredOutputError` (up to 3 attempts). For **side-effect-free** capabilities
  where the output *is* the work (`write-pr`, `to-issues-prd`).
- **`run-with-extraction.ts`** — `runWithExtraction`: the **two-phase** wrapper —
  a *produce* run with no `output` (keeps the resumable `sessionId`, never throws
  on extraction), then a resumed *extract* pass via `runWithRetry`. Returns the
  produce run's commits with the extraction's output, so side effects (commits,
  issue creation) are never repeated. For capabilities with a side-effectful
  produce phase (`review`, `implement-prd`, `implement-pr`, `update-branch`) —
  and for `architecture-review` / `explore`, whose produce phases are read-only
  but investigation-heavy: the split separates the survey from rigid JSON
  emission, the same reliability win, rather than protecting a side effect.
- **`retry-feedback.ts`** — `buildRetryFeedback`: the retry prompt built from a
  `StructuredOutputError`, echoing what the agent emitted and why it failed.
- **`resolve-agent.ts`** — `resolveAgent(labels, capability)`:
  two independent axes. The **label set** picks the provider via
  `resolveProvider` — an explicit `agent:claude` / `agent:codex` pin wins,
  otherwise the `DEFAULT_PROVIDER` constant in this file (the one knob to flip
  when the subscription changes) — reading the subject's full set, not just the
  trigger label. The **capability** then picks
  that provider's model and reasoning effort from a per-capability policy
  (`CAPABILITY_POLICY`), so exploration, implementation, and review each carry
  the profile they need without changing a provider-wide constant. The policy
  encodes a two-tier split: a **Build tier** (`implement`, `implement-prd`,
  `implement-pr`, `update-branch`) runs lean on Claude Code's `claude-opus-4-8`
  at `medium`, letting `review` carry the completeness check; a **Think tier**
  carries `claude-fable-5`, with `write-pr`/`write-prd-pr` at `medium` and the
  judgement-dense `review`/`to-issues`/`architecture-review`/`explore` at `high`
  (Codex `xhigh`). Effort types are derived from Sandcastle's own factory
  options, and `Capability` is a closed union over a `Record`, so adding a runner
  without a policy entry fails the typecheck rather than inheriting a default.
  Also here: `IDLE_TIMEOUT_SECONDS`, the shared idle-watchdog value every runner
  that sets one passes to `run` (1200s, raised for `claude-fable-5`'s longer
  turns), and `logResolvedAgent`, the one resolved-model/effort log line every
  runner emits.

  | Capability | Claude model | Claude effort | Codex model | Codex effort |
  |---|---|---|---|---|
  | `implement` | `claude-opus-4-8` | `medium` | `gpt-5.6-sol` | `medium` |
  | `implement-prd` | `claude-opus-4-8` | `medium` | `gpt-5.6-sol` | `medium` |
  | `implement-pr` | `claude-opus-4-8` | `medium` | `gpt-5.6-sol` | `medium` |
  | `update-branch` | `claude-opus-4-8` | `medium` | `gpt-5.6-sol` | `medium` |
  | `write-pr` | `claude-fable-5` | `medium` | `gpt-5.6-sol` | `medium` |
  | `write-prd-pr` | `claude-fable-5` | `medium` | `gpt-5.6-sol` | `medium` |
  | `review` | `claude-fable-5` | `high` | `gpt-5.6-sol` | `xhigh` |
  | `to-issues` | `claude-fable-5` | `high` | `gpt-5.6-sol` | `xhigh` |
  | `architecture-review` | `claude-fable-5` | `high` | `gpt-5.6-sol` | `xhigh` |
  | `explore` | `claude-fable-5` | `high` | `gpt-5.6-sol` | `xhigh` |
- **`review-output.ts`** — `reviewOutputSchema` (Zod): the `review` capability's
  `<output>` contract — a `summary` plus `findings[]` (each `axis` ∈
  standards/spec, `severity`, `status` ∈ fixed/unresolved, `file`, optional
  `line`, `title`, `detail`). The extraction wrapper validates the emitted block
  against it, so a malformed block self-corrects via same-session retry before
  anything is posted.
- **`explore-output.ts`** — `exploreOutputSchema` (Zod): the `agent:explore`
  capability's contract — one required, non-empty Markdown `comment`. The
  extraction wrapper retries malformed output before the workflow posts the
  issue assessment.
- **`architecture-review-output.ts`** — `architectureReviewOutputSchema` (Zod):
  the `architecture-review` capability's `<output>` contract, copied field-for-field
  from CVM as a **strict discriminated union on `status`** — `proposed` is
  `{status, title, body, oneLineSummary, candidatesConsidered}` (at least one
  non-empty candidate), `skipped` is `{status, reason}`. Strict = extra keys
  rejected, not stripped, so a `skipped` block can't smuggle a `title`/`body` and a
  `proposed` block can't carry a stray `reason`; a malformed or mixed decision
  self-corrects via same-session retry before the workflow opens any PRD. One
  proposal per run — CVM proposes a single fresh deepening opportunity at a time so
  each becomes its own PRD → child-issues flow, not a rolling report.
- **`implement-pr-output.ts`** — `implementPrOutputSchema` (Zod): the
  `implement-pr` capability's `<output>` contract — a `summary` plus `items[]`
  (each a `comment` gist, `status` ∈ addressed/deferred, optional `file`, an
  `action` describing what changed or why it was deferred, and an optional
  `threadId` — the review thread's GraphQL node ID, so the workflow can reply on
  the exact thread an addressed item answers). The extraction wrapper
  validates the emitted block the same way, so a malformed block self-corrects via
  same-session retry before anything is posted.
- **`update-branch-output.ts`** — `updateBranchOutputSchema` (Zod): the
  `update-branch` capability's `<output>` contract — an `outcome` ∈
  merged/already-current/blocked, a `summary`, `conflicts[]` (each a `file` + a
  one-line `resolution` note), and a `reason` (required when `blocked`).
  Refinements require a `reason` for `blocked` and forbid `conflicts` on any
  non-`merged` outcome, so a contradictory block self-corrects via same-session
  retry. The agent's claim is not trusted alone — see `verify-branch-update.ts`.
- **`verify-branch-update.ts`** — `verifyBranchUpdate(facts)`: a pure verifier
  the `update-branch` runner calls to cross-check the agent's success claim
  against the real git state (the remote base is now an ancestor of HEAD, HEAD
  advanced when `merged`, no unresolved paths remain, the repo is not mid-merge,
  the tree is clean). Returns `{ ok }` or `{ ok:false, reason }`; a
  failure fails the runner so an aborted or half-finished merge can never be
  pushed or reported as success (CVM's deterministic postconditions).
- **`implement-prd-output.ts`** — `implementPrdOutputSchema` (Zod): the
  `implement-prd` extraction's `<output>` contract — an `outcome`
  (`completed`/`already-satisfied`/`blocked`) plus a one-line `reason`. Validated
  by the extraction wrapper with same-session retry, so the three-way outcome that
  distinguishes "already done" from "needs a human" can't be a malformed block.
- **`verify-implement-prd.ts`** — `verifyImplementPrdOutcome({ outcome, commitCount })`:
  a pure verifier the `implement-prd` runner calls to cross-check the agent's
  reported outcome against the real commit count — `completed` ⇒ commits > 0,
  `already-satisfied` ⇒ commits == 0, `blocked` ⇒ always a failure. Returns
  `{ ok }` or `{ ok:false, reason }`; a mismatch fails the runner so a
  self-contradictory claim can never close a sub-issue on a false premise (the
  same claim-not-trusted-alone stance as `verify-branch-update.ts`).
- **`verify-explore-read-only.ts`** — `verifyExploreReadOnly(facts)`: checks that
  an exploration left `HEAD` unchanged and the worktree clean before the runner
  writes a publishable comment. The workflow also disables persisted checkout
  credentials and removes `GH_TOKEN` from the agent step, so read-only is an
  enforced boundary rather than only a prompt instruction.
- **`parse-diff-lines.ts`** — `parseDiffLines(diff)`: pure unified-diff parser
  returning the new-side line numbers each file adds/changes. The `review`
  capability uses it to anchor unresolved findings to real changed lines when
  building the inline PR-review comments, so a comment can't point at a line the
  change never touched — and so the reviews API (which 422s the whole review on a
  single off-diff anchor) is never handed a bad line.
- **`print-provider.ts`** — the workflows' window onto `resolveProvider`: reads
  `AGENT_LABELS` and prints `provider=` / `is_codex=` / `provider_label=` as
  GitHub-Actions outputs, so a workflow's provider-specific setup (Codex CLI
  install, provider-label propagation onto a PR) is decided by the same code the
  runner uses rather than a `jq` re-implementation that drifts when
  `DEFAULT_PROVIDER` flips.
- **`prepare-codex-auth.ts`** — `prepareCodexAuth(providerName)`:
  the runner-side half of the Codex path. When the resolved provider is Codex it
  seeds `CODEX_AUTH_JSON` → `$CODEX_HOME/auth.json` **only if that file is absent**
  (Codex refreshes the tokens in place mid-run, so a later phase must not clobber
  them), forces `cli_auth_credentials_store = "file"` in `config.toml` (the OS
  keyring is unreachable in CI), and strips `OPENAI_KEY`/`OPENAI_API_KEY` so Codex
  uses the `gpt-5.6-sol` subscription seat, not the metered API. A no-op when the
  run resolved to Claude. Every capability calls it immediately before `run()`, so the
  setup is uniform across phases. (The seeded secret needs a periodic re-paste —
  Codex's refresh token is single-use; see `docs/agents/sandcastle.md`.)
- **`require-env.ts`** — `requireEnv(name)`: read a required env var or throw a
  named error. The capability scripts run under a fixed workflow-supplied env; a
  missing var is a wiring bug, so failing fast lands the issue in `agent:blocked`.
- **`capability-context.ts`** — branchless `loadIssueCapabilityContext()`,
  branch-mutating `loadCapabilityContext()`, and the PRD-mode
  `loadPrdImplementContext()` / `loadPrdPrContext()`: the one reader of the env
  contract every `agent-*.yml` sets (issue/PRD coordinates, output dir, and the
  provider resolved from the full label set). Each returns the `promptArgs` ready
  to spread into `run()`, so every capability resolves provider + env through this
  seam rather than re-parsing `process.env`.
- **`product-ci.ts` / `product-ci-github.ts` / `product-ci-cli.ts`** — the shared,
  fail-closed Product CI boundary. It reads the live PR, selects only the `CI`
  pull-request run associated with its exact head/base pair, requires the latest
  attempt's `Product` job to complete successfully, bounds diagnostics and
  polling, performs/account successful candidate pushes, revalidates reruns, and
  enforces the two-action recovery budget. The
  GitHub dependency and polling clock are injectable for deterministic tests.
- **`productive-prompt.ts` / `product-ci-prompt.md`** — composes the same Product
  CI publication/recovery contract exactly once into Implement, Implement PRD,
  Review, and Implement-PR before their final reporting/extraction phase.

Later workflow tickets add each capability as a thin `run()` script + YAML on top
of these helpers.

## Capabilities

Each capability is a self-contained directory — a `run()` script + its `prompt.md`
— driven by one `.github/workflows/agent-*.yml`. Workflows own lifecycle and
publication mutations. Four productive calls have one narrow exception: they may
plain-push only their current automation branch, create/update only its same-repo
draft PR, inspect/wait for Product CI, and rerun the current Product CI. They may
not mutate labels, issues, reviews, comments, threads, child state, ready state,
merge state, or any other branch.

- **`implement/`** — the core spine (workflow `agent-implement.yml`). Calls
  `run()` directly (no structured output — the *work is the commits*), guards on a
  non-zero commit count, and relies on the built-in `idleTimeoutSeconds` watchdog
  inside the workflow's 120-min job timeout. Provider resolved from the full label
  set via `resolveAgent`.
- **`write-pr/`** — authors the draft PR's title + body via `runWithRetry`
  (structured output *is* the work), writing flat text files the workflow feeds to
  `gh pr edit --body-file`. Runs after the productive agent has published the
  draft PR; reads and summarises, never commits.
- **`explore/`** — the read-only issue investigation capability (workflow
  `agent-explore.yml`). A human applies `agent:explore`; the workflow reads the
  full label set, so a provider pin (`agent:claude` / `agent:codex`, else
  `DEFAULT_PROVIDER`) routes it like every other capability. The produce pass verifies the issue against the default branch, assesses
  difficulty, relevant files, open questions, implementation shape, and useful
  test seams; the resumed extraction pass validates one non-empty Markdown
  comment. The workflow fetches issue context before withholding GitHub
  credentials from the agent; the runner rejects a changed `HEAD` or dirty tree,
  then writes only `comment.md` to `OUTPUT_DIR`. The workflow posts it, and no
  branch or PR is created.
- **`implement-prd/`** — the PRD variant of the spine (workflow
  `agent-implement-prd.yml`), mirroring CVM's incremental lifecycle: **one**
  sub-issue per run on the resumed accumulating branch, with coordinates + provider
  from `loadPrdImplementContext`. Its job has the shared 120-minute outer timeout,
  which bounds local work, Product CI polling, and at most two recovery actions;
  the shared idle watchdog still catches a non-responsive agent earlier. A
  **two-phase** capability
  ({@link runWithExtraction}): the produce pass implements the sub-issue passed via
  `SUB_ISSUE_NUMBER` (reasoning in prose, committing its work); the resumed
  extraction pass emits an explicit `outcome` — `completed` | `already-satisfied` |
  `blocked` — validated against `implementPrdOutputSchema`. That three-way outcome
  is the point: a plain commit-count guard can't tell an already-done sub-issue
  (legitimately zero commits) from an agent that gave up (also zero commits), so
  the runner fails the run on `blocked` (and on `completed` with no new commits) —
  leaving the sub-issue open and the PRD `agent:blocked` — while `completed`/
  `already-satisfied` may advance only after the existing draft PR head is green.
  A first-child `already-satisfied` result without a PR fails closed, and a CI
  repair commit makes the outcome `completed`. It never closes a sub-issue the
  agent asked for help on.
- **`write-prd-pr/`** — the PRD variant of `write-pr/`, run to reconcile the
  productive agent's draft PR metadata. Same `runWithRetry`
  single-prompt shape, with coordinates + provider from `loadPrdPrContext`; frames
  the body around the **whole PRD** and schema-enforces a single `Closes #<PRD>`
  line — sub-issues are closed by the workflow per-run, not by the PR body.
- **`review/`** — drives the repo's **local `/code-review`** over the PR branch
  (workflow `agent-review.yml`) via `runWithExtraction`. The produce pass reviews
  along both axes, **fixes what it safely can and commits** the fixes, and
  re-reviews; the resumed extraction pass emits the findings as one `<output>`
  block (`extraction.md`), each marked `fixed` or `unresolved`, validated against
  `reviewOutputSchema` with same-session retry. The productive call publishes its
  fixes, obtains green exact-candidate proof, re-reviews after any repair commit,
  and writes a ready-to-POST GitHub *reviews* payload (`review_payload.json` — a
  summary body plus inline comments for unresolved findings, anchored to the diff
  via `parseDiffLines`) plus the reviewed head SHA to `OUTPUT_DIR`. The workflow
  rechecks that head and Product CI immediately before posting the review and
  again before `gh pr ready`. Uses no external skills registry.
- **`architecture-review/`** — the scheduled/on-demand codebase sweep (workflow
  `agent-architecture-review.yml`) via `runWithExtraction` — the autonomous,
  GitHub-native analogue of CVM's interactive `/improve-codebase-architecture`.
  Unlike the others it has **no label trigger and no originating issue/PR**, so it
  reads its own minimal env (the open proposals to dedupe against, an optional
  `AGENT_LABELS` for the provider — empty ⇒ `DEFAULT_PROVIDER` — plus `OUTPUT_DIR`) instead
  of `loadCapabilityContext`. The produce pass surveys the tree in prose for the
  **single freshest deepening opportunity** — described directly with the
  `/codebase-design` vocabulary, **not** by running the interactive
  `/improve-codebase-architecture` skill (which is `disable-model-invocation` and
  needs an HTML report + a human); the resumed extraction pass emits a
  `proposed | skipped` decision validated against `architectureReviewOutputSchema`
  (one PRD per run, not a findings list). **Read-only** — it commits nothing; per
  invariant H it only writes `architecture_status.txt` and `architecture_summary.txt`
  (the `oneLineSummary` when proposed, the `reason` when skipped), plus — when
  `proposed` — `architecture_candidates.txt`, `prd_title.txt`, and `prd_body.txt`
  to `OUTPUT_DIR`. The workflow dedupes against **open *and closed***
  `source:architecture-review` proposals with an explicit high `--limit` (so a
  completed or rejected idea is never re-raised and the default-30 page never
  silently truncates history), skips the run once ten are **open**, opens the
  proposed PRD with that provenance label (provisioned once by `provision-labels.sh`;
  a human later expands it with `agent:to-issues`), and always writes a run summary
  (proposed PRD + one-line summary + candidates, skip reason, or backlog-full).
- **`implement-pr/`** — addresses the review comments on an open PR (workflow
  `agent-implement-pr.yml`) via `runWithExtraction`. The produce pass reads the
  PR's review threads via **GraphQL** (which exposes each thread's `isResolved`
  state and node `id`, unlike the REST comments endpoint), **changes what it
  safely can and commits** the fixes, running the repo's typecheck/test on what it
  touches; the resumed extraction pass emits one `<output>` block
  (`extraction.md`) recording each comment as `addressed` or `deferred` — with the
  addressed thread's `threadId` — validated against `implementPrOutputSchema` with
  same-session retry. The productive call publishes fixes, obtains green
  exact-candidate proof, refreshes feedback after any repair commit, then writes a
  Markdown summary (`pr_comment.md`), its green head SHA, and a
  `thread_replies.json` ({threadId, body} per answered thread) go to `OUTPUT_DIR`.
  The workflow pushes the commits, replies on each answered thread — `addressed`
  (the fix) *or* `deferred` (the reason it was left), CVM-style, reply only;
  resolution stays the reviewer's call — after checking each `threadId` against
  the PR's real **unresolved** threads (so a hallucinated/cross-PR/already-resolved
  id can't be replied to), and posts the summary comment. It refuses cleanly up
  front when the PR has no unresolved threads, comments, *or* non-approval review
  bodies to address (no wasted run), and a runtime guard fails the run (→
  `agent:blocked`) if it still produced no commits and no items, or claims
  `addressed` items with zero commits. It does **not** change the PR's draft/ready
  state — that belongs to the review leg. Shares the per-PR concurrency group with
  `review`.
- **`update-branch/`** — brings a stale or conflicted PR branch current with
  its base (workflow `agent-update-branch.yml`). The workflow resolves the common
  cases **deterministically, without an agent**: an already-current branch is a
  no-op, and a conflict-free merge is done with `git merge` in a shell step. Only
  when that merge hits **real conflicts** is the agent invoked (via
  `runWithExtraction`) — its produce pass re-merges the remote base, resolves the
  conflicts, runs the repo's checks, and commits; the resumed extraction pass
  emits the `<output>` block (`extraction.md`) validated against
  `updateBranchOutputSchema`. Before anything is pushed, the runner cross-checks
  the agent's claim against the real git state (`verify-branch-update.ts`); a
  failed postcondition — or an agent that reports `outcome: blocked` — fails the
  run into `agent:blocked` with the agent's reason, so an aborted merge is never
  pushed or reported as success. Per invariant H the runner only commits + writes
  files: the merge commit lands on the branch (the workflow pushes it — a plain,
  non-force push) and `update_branch_comment.md` goes to `OUTPUT_DIR`. **Merge,
  never rebase** — history only grows, so the non-force push is always valid.
- **`to-issues/`** — decomposes a PRD issue into agent-sized child issues
  (workflow `agent-to-issues.yml`) via `runWithRetry` (structured output *is* the
  work — no branch, no commits). Copies CVM's `to-issues-prd` contract: the agent
  emits `slices[]` (`title`, `whatToBuild`, `acceptanceCriteria[]`) — vertical
  tracer-bullet slices with **no dependency field and no summary** (emitted list
  order is the only phase signal) — validated against `toIssuesOutputSchema`
  (CVM's `PromptOutput`) with same-session retry. The runner then
  **deterministically renders** each slice's issue body (`renderSliceBody`,
  byte-for-byte CVM's `renderBody` — `## Parent PRD` back-reference, "What to
  build", and a `- [ ]` acceptance checklist) and writes `child_issues.json`. It
  reads the PRD coordinates through the shared PRD-mode seam (`loadPrdPrContext`,
  `PRD_NUMBER`/`PRD_TITLE`), so no branch is involved. The deliberate divergence
  from CVM is that CVM's runner does the
  `gh issue create` itself, whereas here the runner only writes files and the
  **workflow** does every `gh issue create` + sub-issue link.

## Pinned version

`@ai-hero/sandcastle` is pinned to **0.12.0** (current latest), reconciling the
0.12-vs-`^0.10` drift the spec flagged. The helpers rely on `run()`'s structured
`output` + `StructuredOutputError.sessionId` resume path, verified against 0.12.0's
type definitions. Two 0.12 behaviours the wrappers depend on:

- `run()` rejects an inline `prompt` alongside any `promptArgs`
  (`validateNoArgsWithInlinePrompt`), so both wrappers drop `promptArgs` (and
  `promptFile`) when switching to an inline retry/extraction prompt.
- `StructuredOutputError` carries `sessionId`/`rawMatched`/`cause`, which is what
  makes same-session resume-with-feedback possible.

Models follow the per-capability policy in `resolve-agent.ts` (issue #88): the
Build tier on `claude-opus-4-8` and the Think tier on `claude-fable-5`, not CVM's
`claude-opus-4-6` or a single provider-wide model. Effort is per capability, not
uniform. `claude-fable-5` availability on the `CLAUDE_CODE_OAUTH_TOKEN` seat was
confirmed manually; no API key is introduced, and both providers remain on flat
subscription seats.
