#!/usr/bin/env bash
#
# Provision the `agent:*` label set for the Sandcastle autonomous-agent platform
# (spec #52, §D). Idempotent: `gh label create --force` creates-or-updates, so
# re-running only reconciles colours/descriptions. Triage and wayfinder labels are
# NOT touched here — they are provisioned separately (docs/agents/triage-labels.md).
#
# Usage:  ./.sandcastle/provision-labels.sh [owner/repo]
# Default repo is the current directory's origin.

set -euo pipefail

REPO="${1:-}"
repo_arg=()
if [[ -n "$REPO" ]]; then
  repo_arg=(--repo "$REPO")
fi

# name | colour (hex, no #) | description
# Four layers per spec §D + #70: the provider labels, the agent state machine, and
# the source:architecture-review provenance label.
# Both provider labels are optional and symmetric: each PINS a subject to that
# provider, and neither present means DEFAULT_PROVIDER (.sandcastle/resolve-agent.ts).
labels=(
  "agent:claude|8250df|Provider (optional): pin this issue to Claude Code, whatever the default provider is"
  "agent:codex|8250df|Provider (optional): pin this issue to Codex/gpt-5.6-sol, whatever the default provider is"
  "agent:implement|0e8a16|Human trigger: start an autonomous implementation run on this issue"
  "agent:in-progress|fbca04|Machine: a run is actively working this issue (added on start, removed on finish)"
  "agent:review|1d76db|Machine: an implement run finished; fire the automated PR review"
  "agent:implement-pr|006b75|Trigger: ask an agent to address review comments on this PR"
  "agent:update-branch|5319e7|Trigger: refresh this stale PR branch against its base"
  "agent:to-issues|c5def5|Trigger: expand this PRD issue into agent-sized child issues"
  "agent:explore|bfdadc|Human trigger: investigate an issue read-only and post an implementation assessment"
  "agent:queued|d4c5f9|Machine: blocked by another open issue; auto-promotes to agent:implement when the blocker closes"
  "agent:blocked|b60205|Machine: a run stopped (crash, timeout, or the agent asked for a human); see the linked run"
  # Provenance (spec #70): marks a PRD proposed by the scheduled
  # architecture-review agent — the dedupe key and the open-proposal-cap backlog.
  "source:architecture-review|5319e7|Provenance: PRD proposed by the scheduled architecture-review agent"
)

for entry in "${labels[@]}"; do
  IFS='|' read -r name colour description <<<"$entry"
  echo "→ ${name}"
  gh label create "$name" \
    --color "$colour" \
    --description "$description" \
    --force \
    ${repo_arg[@]+"${repo_arg[@]}"} # +-guard: empty-array expansion is safe under `set -u` on Bash 3.2 (macOS)
done

echo "Done — ${#labels[@]} agent:* / source:* labels provisioned."
