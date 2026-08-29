# Coloop private observability trial

The trial has three independent paths:

- Product events use `createPostHogProductExporter` and PostHog Cloud as the
  first remote analysis destination.
- Operational events use `createOtlpOperationalExporter` and the pinned local
  OpenTelemetry Collector in `collector/`. The checked-in configuration keeps
  local JSONL diagnostics; an Owner may add or replace an OTLP exporter for
  Grafana Cloud without changing Product Analytics or Agent tracing.
- Full OpenAI Agents SDK traces remain off unless
  `createPrivateAgentTracePolicy` accepts every private-trial control for that
  Agent turn. The local kill switch is evaluated on every turn.

The application stream is positive-allowlist only. It uses a random telemetry
Episode identity and must never carry the domain Episode identity, provider
identifiers, credentials, Context Packages, Discord content, Agent content,
proposals, Outcomes, raw errors, or tool data. Export is bounded and lossy;
SQLite and local diagnostics remain authoritative.

## Start the local Collector

From this directory:

```sh
docker compose -f collector/compose.yaml up
```

Point the operational exporter at `http://127.0.0.1:4318`. The Collector image
is pinned to `0.153.0`; upgrades are explicit repository changes. The default
configuration has no remote operational destination. This keeps Grafana Cloud
evaluation optional and independently disableable.

## Trial controls

Before enabling full Agent capture, record that the Owner opted in, every
participant can see the disclosure, access is restricted, and retention and
deletion controls were verified. Do not enable it when the local kill switch is
set or when Agent content contains a recognized credential. Stop at the first
of 30 elapsed days, 30 consenting Episodes, or 300 accepted Agent turns. Once
billing is enabled, stop when monthly observability spend reaches $10.

At each fixed review, verify and record:

1. Product Analytics receipt and querying in PostHog.
2. local operational-log receipt and querying, plus remote receipt if enabled.
3. correlation of both streams by only the random telemetry Episode identity.
4. observed export delay and reproducibility from the same allowlisted input.
5. alert behavior at the trial and spend limits.
6. deletion of private full-trace data within the configured retention control.

Exporter delay, duplication, failure, or outage is never an Episode recovery
signal and must not gate lifecycle, SQLite, Discord delivery, or Outcome return.
