# Agents SDK primary Episode runtime verdict

Exercise date: 2026-08-29

## Verdict

**Use the TypeScript Agents SDK as the primary v0 Episode runtime.** One manager
Agent is sufficient in deterministic and live Owner evidence for multi-turn streaming, OpenAI-managed
continuation, restart between completed turns, provider-failure retry,
idempotency, in-flight restart, and structured Episode Outcome generation.

`@openai/agents` 0.17.0 passed all nine checks. After aborting a tool-free
streaming run and serializing its `RunState`, the snapshot contained the exact
in-flight collaborator turn, no prior completed turn, no Context Package body,
and the last `previousResponseId`. After reconstruction with
`RunState.fromString()`, the SDK called the model with that original input.

This result is deliberately language-specific. The comparative Python SDK
0.22.0 probe passed eight of nine checks but resumed the equivalent cancelled
run with zero new input items. Coloop should not infer runtime semantics across
the two SDK implementations.

The live `gpt-5.6-luna` exercise then streamed two real turns around a local
runtime restart. The second turn correctly resolved a reference to the first
through OpenAI-managed continuation, and finalization returned a valid
`EpisodeOutcome`. The Owner judged the interaction sufficient for v0 and chose
to keep successful restart recovery invisible by default, exposing only a
minimal status or error when recovery affects the user.

## What the TypeScript exercise established

| Concern | Result |
| --- | --- |
| Manager shape | One Agent handled every call with zero tools and zero handoffs. |
| Streaming | Every model call used the streaming path. |
| Provider-managed continuation | Each turn after opening used the prior response ID; no local history or SDK Session was supplied. |
| Restart between turns | A fresh store and Agent loaded the response ID, accepted a re-fetched Discord event, and continued. |
| Provider failure | The response ID remained unchanged and the Discord event stayed pending for retry. |
| Duplicate Discord delivery | A completed event ID plus content hash suppressed the duplicate before a model call. |
| Arbitrary run interruption | **Passed in TypeScript.** Serialized `RunState` retained and re-forwarded the current accepted input after restart. |
| Finalization | The manager with a Zod `EpisodeOutcome` schema returned conclusion plus unresolved points. |
| Local content | SQLite held no completed transcript or Context Package body; temporary `RunState` contained only the current in-flight input and was cleared after resume. |
| Retention | Finalization wrote a +72-hour deadline and left the private `0400` Context Package for cleanup. |

## State ownership implied by the evidence

SQLite retains Episode phase, Discord routing/event IDs and content hashes,
idempotency status, the latest response ID, Context Package path and retention
deadline, finalized Outcome until acknowledged, delivery state, and—only during
an interrupted run—the serialized current-turn `RunState`. Discord remains the
source of completed message content during reconciliation. OpenAI retains the
conversation chain addressed by response ID.

Serialized `RunState` is not text-free. Temporary Owner-local persistence is
compatible with “no local transcript mirror” only if it is narrowly scoped,
protected like other sensitive local state, and deleted immediately after
resolution. It is incompatible with a stronger rule that no conversation text
may ever reach SQLite.

## Accepted v0 boundary

Successful restart recovery has no user-facing marker by default. Coloop must
avoid behavior that appears to hang or produces duplicate or missing visible
events, and must show a minimal status or error when recovery materially affects
the user. Whether silent recovery confuses users remains a validation concern,
not a blocker for the v0 runtime selection.
