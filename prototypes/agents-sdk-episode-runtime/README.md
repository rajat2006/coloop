# Agents SDK primary Episode runtime probe

This disposable TypeScript exercise asks whether one Owner-local OpenAI Agents
SDK manager Agent can be the primary Episode Agent for a Discord-shaped,
multi-turn Collaboration Episode. It deliberately has no tools, specialists, or
handoffs. TypeScript is authoritative because Coloop's intended runtime is
JavaScript; `probe.py` remains as comparative evidence.

It exercises two restart seams:

1. **Between completed turns:** SQLite retains only `previous_response_id`,
   Discord identifiers/hashes, Episode state, and retention metadata. After a
   restart, a missed Discord event is re-fetched and sent as the next turn.
2. **During an Agent run:** an aborted streaming result is serialized with
   `RunState.toString()`, loaded into a new process boundary with
   `RunState.fromString()`, and resumed.

The probe creates a private `0400` synthetic `context-package.md` outside the
repository, streams every reply, disables SDK tracing, injects a provider
failure, suppresses duplicate Discord delivery, produces a schema-constrained
Episode Outcome, and marks the Context Package for terminal retention at +72
hours. SQLite never stores completed Discord or Agent messages. It temporarily
stores the accepted in-flight turn inside serialized `RunState` and clears that
snapshot immediately after resolution.

## Run the authoritative deterministic exercise

Node 24 is required. The deterministic mode uses the SDK's `ScriptedModel` and
makes no API request.

```bash
cd prototypes/agents-sdk-episode-runtime
npm install
npm run typecheck
npm run offline
```

To keep the generated evidence:

```bash
npm run offline -- --workspace /tmp/coloop-ts-runtime --output evidence.json
```

The checked-in `evidence.json` passes all nine deterministic acceptance checks on
`@openai/agents` 0.17.0. In particular, the resumed model call contains the
original accepted input and retains its prior `previousResponseId`.

`live-evidence.json` records the subsequent live Owner interaction without
retaining either collaborator turns or Agent replies. Two streamed turns
continued across a local runtime restart, structured finalization succeeded,
and the Owner accepted the manager interaction for v0.

## Repeat the live Owner interaction

Use a separately funded OpenAI Platform API key. Subscription Codex
authentication is not an Agents SDK API credential.

Set `OPENAI_API_KEY` in the ignored repository-root `.env`, then run:

```bash
npm run owner -- --workspace /tmp/coloop-owner-runtime
```

Enter at least two collaborator turns, use `/restart`, enter another turn, then
use `/finalize`. Use only the synthetic material created by the probe. The
workspace is disposable and may be deleted after inspection.

## Inspect the interaction without an API key

Open `index.html` in a browser. Its guided cases expose the complete application
state and the recovery-marker interaction for Owner feedback; it is a state
walkthrough, while `evidence.json` is the deterministic SDK evidence.

## Python comparison

`probe.py` pins OpenAI Agents SDK for Python 0.22.0. It passed eight of nine
equivalent checks: its arbitrary-cancellation resume invoked the model with zero
new input items. That difference is the reason the TypeScript probe is the
decision artifact for a JavaScript production runtime rather than an assumed
cross-language equivalence.

Official OpenAI documentation used by the exercise:

- [Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [Results and state](https://developers.openai.com/api/docs/guides/agents/results)
- [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
