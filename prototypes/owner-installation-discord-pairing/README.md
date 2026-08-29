# Owner installation and Discord pairing prototype

This is a throwaway browser review harness for one question: which **CLI setup
experience** lets an Owner install and verify an Owner-local Coloop runtime,
understand credential custody, recover from partial setup, and know when the
runtime is ready to open a Collaboration Episode? The browser is not a proposed
Coloop setup surface.

It contains three structurally different variants on one route:

- `?variant=A` — Interactive wizard: one terminal prompt at a time.
- `?variant=B` — Setup plan: the full terminal checklist with explicit resume.
- `?variant=C` — Doctor and repair: scan first, then fix only detected problems.

Run it from the repository root:

```bash
pnpm prototype:owner-setup
```

Then open <http://127.0.0.1:4210/?variant=A>. Use the floating switcher or the
left and right arrow keys to compare variants.

## What is simulated

The prototype does not call Discord, OpenAI, Codex, or SQLite. Every terminal
action changes in-memory state only. The scenario controls can load a fresh
install, a recoverable partial install, or an invalid Platform credential. Do
not enter real credentials.

V0 reads `DISCORD_TOKEN` and `OPENAI_API_KEY` from the environment supplied to
`coloop setup` and `coloop run`. Coloop validates them but does not persist or
display credential text. The OpenAI Platform credential for the Episode Agent
is explicitly separate from the Owner's existing Codex CLI authentication.
Secure local persistence is post-v0 future work.

## Settled constraints represented here

- One Owner-local Coloop runtime owns the Discord connection, Episode state,
  Agents SDK execution, cleanup, and restart reconciliation.
- One installation allows one Discord server and parent channel and has one
  durable Owner Pairing based on the exact Discord user ID.
- SQLite holds durable identifiers and operational state. Private Episode
  directories hold `context-package.md`; credentials enter neither location.
- The Codex CLI hook and MCP origin adapter bind an Origin Session to a
  Collaboration Episode. Only the validated CLI client/version is accepted.
- Setup must verify Discord permissions, Platform connectivity, private local
  paths, and runtime readiness without writing secrets to diagnostics or logs.

This folder is evidence, not production code.
