# Verdict

**Status: accepted.**

## Question

Which CLI setup structure makes credential custody, Discord access, Owner
Pairing, the Codex origin adapter, local storage, runtime startup, and recovery
clear without requiring a Coloop setup UI?

## Selected structure

The Owner selected **A — Interactive wizard** as the v0 setup structure because
Coloop should start with the simplest implementation. `coloop setup` presents
one ordered prompt at a time and opens provider sites only when the Owner must
act there.

The Owner also selected these supporting behaviors:

- Owner Pairing accepts the numeric Discord user ID, verifies that it resolves
  in the configured server, displays the resolved account, and requires a final
  confirmation. A short-lived Discord pairing code adds too much v0 friction.
- Recovery uses the same `coloop setup` command. It checks saved non-secret
  configuration, skips completed steps, and continues at the first failed step;
  there is no separate resume command.
- Setup exits after its final readiness check. `coloop run` separately starts
  the Owner-local runtime in the foreground.
- V0 reads `DISCORD_TOKEN` and `OPENAI_API_KEY` from the environment supplied to
  `coloop setup` and `coloop run`. Coloop validates presence and provider
  connectivity but never persists credential values. The Owner is responsible
  for supplying them after restart. [Explore secure local credential
  persistence after v0](https://github.com/rajat2006/coloop/issues/30) is
  standalone future work outside this Wayfinder map.

## Rejected as the primary setup flow

- **B — Setup plan:** prints the complete checklist, runs one selected step at a
  time, and makes `coloop setup --resume` explicit.
- **C — Doctor and repair:** scans first, repairs only failed checks, and asks
  before changing local configuration or opening a provider site.

These variants add navigation and repair surfaces that are not necessary for
the first implementation. Their evidence remains in the prototype; they do not
define the primary v0 flow.

## Deliberate limits

- Provider calls, secret-store writes, Discord installation, Codex config
  changes, SQLite creation, and runtime processes are simulated.
- The browser is only a review harness. It is not a proposed setup surface.
- The exact secret mechanism and production command names are placeholders.
- “Prototype Agents SDK as the primary Episode runtime” has not yet supplied a
  final live runtime verdict. This prototype checks setup comprehension, not
  Agents SDK feasibility.
