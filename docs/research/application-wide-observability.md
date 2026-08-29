# Application-wide analytics, logs, and metrics

Research date: 2026-08-29

## Question

What application-wide product analytics, operational logs, application metrics,
distributed traces, and Agent-derived measurements does Coloop v0 need in addition
to Agent tracing? Should PostHog be the only remote observability backend, or should
operational telemetry go to a separate OpenTelemetry backend?

This report assumes, as the ticket requires, that the first private PostHog trial
captures full Agent traces from a small set of real, consenting Collaboration
Episodes. It does not reopen that trial configuration. It specifies the signals that
Agent tracing cannot provide, the boundary around them, and the test that decides
whether the trial should become an ongoing topology.

## Decision

Use **PostHog Cloud as the single remote analysis backend for the bounded Owner-local
v0 trial**, but do not use PostHog as Coloop's telemetry API, local diagnostic store,
recovery system, or operational control plane. “Single remote backend” means only
that every optional Cloud view lands in PostHog during the trial. Local readiness,
diagnostics, recovery, retry, cleanup, and Owner action continue to work offline.

The application should own a small, versioned telemetry adapter:

- Product events go through a `ProductAnalytics` port to PostHog's server capture
  API because product analytics is not an OpenTelemetry signal.
- Sanitized operational logs, application metrics, and application spans use
  OpenTelemetry data types and OTLP/HTTP through a local OpenTelemetry Collector.
- The settled full Agent-trace trial from [Research the Episode event journal and
  observability storage](https://github.com/rajat2006/coloop/issues/28) remains a
  **separate consented stream** using its already-selected PostHog integration.
  This application-wide observability design does not put that stream through the
  application Collector, add a custom metadata
  filter to it, or remap it into the application schema. PostHog AI derives the
  Agent measurements from that stream. The application-telemetry stream never
  imports its prompt, reply, tool, or raw-error content, and the Agents SDK's private
  trace schema never becomes Coloop's application-wide schema.
- Structured JSON stderr and an on-demand, content-free diagnostic snapshot remain
  usable with no Collector, network, or vendor account.

A standalone Collector **is warranted in Owner-local v0 for this bounded trial**, but
only as a pinned, Coloop-managed sidecar/child process with checked-in configuration.
It is not an Owner-administered observability service and is not part of runtime
readiness. It earns the extra process by enforcing the second export allowlist,
handling PostHog's separate logs/metrics/general-trace endpoints and credentials,
bounding batch/retry behavior, and enabling the required Grafana fan-out benchmark
without an application change. Defer a durable Collector queue, Collector gateway, and
independently operated daemon to hosted deployment; if the managed child is absent
or fails, Coloop keeps local diagnostics and disables remote export.

PostHog is a reasonable one-backend trial because it puts product analytics, AI
traces, OTLP logs, general traces, and application metrics in one project. Its Logs
product accepts OTLP and supports search and alerts; general distributed tracing is
currently **beta**; and application metrics is **alpha**. PostHog log alerts evaluate
every five minutes and count matching records over fixed windows, which is adequate
for a private trial but not a general on-call system. [PostHog Logs](https://posthog.com/docs/logs),
[distributed tracing](https://posthog.com/docs/distributed-tracing), [application
metrics](https://posthog.com/docs/metrics), [log alerts](https://posthog.com/docs/logs/alerts)

Do **not** add Grafana Cloud, SigNoz, Prometheus, Loki, or Tempo to v0 merely to avoid
the PostHog alpha/beta labels. Split PostHog Product Analytics and AI Observability
from operational telemetry into Grafana Cloud if the bounded validation shows that
PostHog cannot satisfy the specific query, alert, retention, or price gates in this
report. Grafana Cloud is the leading managed split alternative. SigNoz is the
leading integrated OTel-native alternative when its Cloud minimum or self-hosting
burden is acceptable.

The critical architectural limit is non-negotiable: PostHog and the Collector are
**lossy egress**. SQLite remains authoritative for Episode Phase, provider inbox and
continuation, pending delivery, reconciliation, cleanup deadlines, and unacknowledged
Episode Outcome return. No dashboard, trace, log, metric, or analytics event is read
to recover a Collaboration Episode. This follows [Research the Episode event journal
and observability storage](https://github.com/rajat2006/coloop/issues/28) and the
supporting [Episode persistence and observability storage](./episode-event-journal-observability.md)
research.

## Evidence and recommendation convention

Capability, protocol, status, price, limit, and documented default claims link to
current primary sources. Event names, schemas, thresholds, retention choices, and
the backend verdict are recommendations derived from those facts and the pinned
Coloop domain model. They are not descriptions of production instrumentation that
already exists.

The pinned domain language is used literally:

- A **Collaboration Episode**, not a session, is the bounded exchange.
- **Episode Phase** is the business lifecycle and is independent of infrastructure
  health. `OPENING`, `ACTIVE`, `FINALIZED`, and `CANCELLED` are business phases;
  `DEGRADED` and `FAILED` are not new phases.
- The **Episode Agent** is the agent assigned to one Collaboration Episode.
- The **Episode Outcome** is immutable structured text accepted by the Owner. Its
  content is never an analytics property, metric label, operational log, or
  application-span attribute.
- **Owner Pairing**, **Origin Session**, **Context Package**, **Opening Brief**, and
  **Outcome Proposal** keep their established meanings.

## Five signal classes, five purposes

| Class | Question it answers | Identity/cardinality | v0 destination | Recovery value |
| --- | --- | --- | --- | --- |
| Product analytics | Are installations activating and are Owners reaching Coloop's product value? | Pseudonymous installation and Episode identifiers; deliberate event properties | PostHog Product Analytics | None |
| Operational logs | What discrete state change, retry, or failure occurred? | Correlation IDs allowed; fixed event body and allowlisted attributes | JSON stderr and PostHog Logs via OTLP | None |
| Application metrics | Is the runtime healthy in aggregate right now and over time? | Low-cardinality labels only; never installation, Episode, Discord, trace, or request IDs | Local diagnostic snapshot and PostHog Metrics trial | None |
| Distributed/application traces | Where did one accepted operation spend time across Discord, SQLite, Agent, and delivery boundaries? | Random trace/span IDs and safe telemetry IDs | PostHog Distributed Tracing trial | None |
| Agent-derived measurements | What did the Episode Agent/model do, how long did it take, how many tokens did it consume, and what did it cost approximately? | Agent trace and generation hierarchy; content allowed only under the assumed trial | PostHog AI Observability | None |

Combining these in one vendor does not collapse the distinctions. A product event is
not an operational log, an Agent trace is not evidence that a Discord reply was
acknowledged, and a trace span is not a durable phase transition.

OpenTelemetry defines traces, metrics, and logs, and its OTLP exporters preserve the
OTel data model across compatible backends. Product-adoption events remain a
separate application contract. The current JavaScript implementation marks traces
and metrics stable and logs in development, so Coloop should keep its structured log
record type independent of the OTel JS logging package. [OpenTelemetry JavaScript
status](https://opentelemetry.io/docs/languages/js/), [JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/)

## What Agent tracing derives—and what it cannot

The current TypeScript Agents SDK traces the top-level run, task, agent, turn,
generation, function tool, guardrail, and handoff hierarchy. Task and turn spans
aggregate request/token use; generation spans include model usage; spans have start
and end time; and custom processors can replace or supplement the default OpenAI
exporter. Generation and function spans can contain model/tool inputs and outputs,
which is why the full-trace private trial has a distinct consent and access boundary.
[OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/),
[generation span API](https://openai.github.io/openai-agents-js/openai/agents/functions/creategenerationspan/)

### Automatically derivable from a complete Agent trace

| Measurement | Derivation | Qualification |
| --- | --- | --- |
| Agent invocation count and duration | Run/task/agent span boundaries | Only work inside the Agents SDK; it excludes opening, Discord delivery, and Outcome return outside the run. |
| Turn count and duration | Turn spans | An Agent turn is not necessarily a Discord delivery or accepted business command. |
| Model/generation count and duration | Generation spans | Provider/client retry details are included only if the SDK/exporter exposes them; do not assume they are complete. |
| Input, output, cached-input, and cache-write tokens | Task/turn/generation usage | Use provider-reported billable counts when present. Do not estimate tokens offline when the provider supplies none. |
| Model and provider | Generation attributes | Preserve the trace value under the trial policy. If a portable aggregate projection is later approved, normalize it to an allowlisted model family. |
| Tool calls, handoffs, and guardrails | Their native spans | Tool input/output content is part of the full-trace trial only and is never copied into operational logs. |
| Agent/model error count and class | Failed spans and error status | Use the settled trace view as available. If projected later, map only to a bounded `error.type`; raw provider bodies are not application logs. |
| Approximate model cost | Token counts multiplied by a versioned price table, or PostHog's known-model calculation | This is an estimate for product/engineering analysis, not the provider invoice or budget authority. PostHog exposes model, token, cost, latency, and trace views. [PostHog AI Observability](https://posthog.com/docs/ai-observability) |

OpenTelemetry's current GenAI conventions define development-stage metrics including
`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`,
`gen_ai.invoke_agent.duration`, Agent inference-call counts, and tool-call counts.
Do not build that mapping for the initial full-trace trial: its already-selected
PostHog integration is the measurement source. If a later hosted or split-backend
decision needs a vendor-neutral **projection** of Agent measurements, use those names
through a separately reviewed, versioned mapper rather than inventing equivalent
Coloop metrics. [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)

### Coloop must emit these explicitly

Agent tracing cannot reliably infer any of the following:

| Missing fact | Required explicit signal |
| --- | --- |
| Installation activated and Owner Pairing completed | Product event after the corresponding durable/application milestone |
| Owner changed observability opt-in or used a Coloop feature | Product event from the control surface |
| Collaboration Episode entered `OPENING`, `ACTIVE`, `FINALIZED`, or `CANCELLED` | Product event after the SQLite transaction commits, plus a metadata-only operational log |
| Episode Outcome was actually acknowledged by the Origin Session | `episode_outcome_returned` product event and delivery log after acknowledgement, not when queued |
| Discord Gateway connected, heartbeat acknowledged, disconnected, resumed, or re-identified | Gateway metrics and state-change logs from the Discord adapter |
| Missed Discord events were replayed/reconciled and duplicates suppressed | Reconciliation span, metrics, and summary log from the inbox/reconciliation component |
| A Discord or Origin delivery is pending, retried, acknowledged, or quarantined | Outbox gauges/counters and state-change logs |
| SQLite is open, migrated, responsive, busy, corrupt, oversized, or accumulating WAL pages | Local readiness checks, metrics, and health logs |
| A Context Package or other restricted artifact is overdue for deletion | Cleanup gauges, run summary, and local alert |
| Provider quota/rate-limit state or account-level spend | Explicit provider response classification and configured-budget comparison; Agent cost is not billing truth |
| Telemetry failed to initialize, export, retry, flush, or fit in its queue | Adapter/Collector self-observation and local diagnostics |
| Process start, stop, version, readiness, restart, or clock | Runtime logs/resource attributes and a local status snapshot |

OpenAI's organization Usage and Costs endpoints use an Admin API key, not the
Owner-supplied project API key selected for v0 inference. Coloop therefore must not
request or store an organization Admin key merely to populate a dashboard. It can
surface rate-limit and quota failures from provider responses, compare trace-derived
cost estimates with an optional Owner-configured budget, and label the result as an
estimate. Account-level spend remains an external Owner check until the selected
project credential can expose it with least privilege. [OpenAI organization Usage
API](https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/usage)

Discord requires heartbeats and Heartbeat ACKs, says a client missing an ACK should
terminate and reconnect, and uses the last sequence number plus `session_id` and
`resume_gateway_url` to replay missed events after Resume. Those are application
adapter facts outside any model run. [Discord Gateway lifecycle](https://docs.discord.com/developers/events/gateway)

## Canonical v0 schema

### Common resource attributes

Every OTel resource and product event uses these allowlisted fields:

| Attribute | Type | Rule |
| --- | --- | --- |
| `service.name` | enum | `coloop-bridge`; never user-configurable free text |
| `service.version` | string | Release version or build SHA; maximum two active releases in a v0 dashboard |
| `deployment.environment.name` | enum | `development`, `test`, `staging`, or `production` |
| `coloop.runtime.mode` | enum | `owner_local` or `hosted`; v0 emits `owner_local` |
| `coloop.telemetry.schema.version` | integer | Starts at `1`; increment on incompatible meaning or type change |
| `coloop.installation.telemetry_id` | UUID | Random at installation, unrelated to Owner/Discord/provider IDs; product `distinct_id` and trace/log correlation only |

`deployment.environment.name` is the stable OTel deployment-environment attribute,
and OTel SDKs accept service/resource data through `OTEL_SERVICE_NAME` and
`OTEL_RESOURCE_ATTRIBUTES`. [OpenTelemetry deployment attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/deployment/),
[resource SDK](https://opentelemetry.io/docs/specs/otel/resource/sdk/)

Do not attach host name, OS user name, filesystem path, IP address, Discord server,
Owner, collaborator, or Origin Session to the resource. In hosted mode,
`service.instance.id` may identify a process for traces/logs but must be removed from
metric labels.

### Vendor-independent correlation

| Field | Scope | Where it may appear | Where it must not appear |
| --- | --- | --- | --- |
| `trace_id` / `span_id` | One application execution graph | Application spans and operational logs | Metrics; recovery queries |
| `coloop.installation.telemetry_id` | One installation until deletion/reset | Product events, logs, traces | Metrics labels; Discord; provider calls |
| `coloop.episode.telemetry_id` | One Collaboration Episode | Episode product events, logs, application/Agent traces | Metrics labels; provider/Discord IDs |
| `coloop.operation.id` | One accepted input/control/delivery operation | Product milestone, log, and trace for that operation | Metrics; idempotency keys |

Generate all four independently of PostHog. Persist the Episode telemetry ID and any
in-flight operation telemetry ID next to the relevant local row only so correlation
survives restart. They are **not** deduplication keys and recovery must ignore them.
The local database ID, Discord snowflake, Gateway sequence, OpenAI response ID,
provider request ID, content hash, and outbox idempotency key never leave SQLite.

This creates a one-way debugging link:

```text
safe telemetry Episode ID in SQLite ──> product/log/trace views

PostHog unavailable or project deleted ──> no effect on SQLite recovery
```

### Product event inventory

Capture all product events after the named application milestone succeeds. Product
events are not retried through the recovery outbox and may be lost.

| Event name | Emit when | Event-specific attributes |
| --- | --- | --- |
| `installation_activated` | First startup reaches usable Owner-local status | `activation_path` enum (`fresh`, `upgrade`), `elapsed_ms` |
| `owner_pairing_completed` | Owner Pairing is durably established and verified | `pairing_provider=discord`, `elapsed_ms` |
| `episode_opened` | The `OPENING` phase commit succeeds | `origin_adapter=codex`, `collaborator_count_bucket`, `context_size_bucket` |
| `episode_activated` | The `ACTIVE` phase commit succeeds | `opening_elapsed_ms`, `opening_attempt_bucket` |
| `episode_finalized` | The `FINALIZED` phase commit succeeds | `active_duration_bucket`, `accepted_turn_count_bucket`, `feature_set` allowlisted array |
| `episode_cancelled` | The `CANCELLED` phase commit succeeds | `prior_phase`, `reason_class` enum, `active_duration_bucket` |
| `episode_outcome_returned` | The Origin Session acknowledges the Episode Outcome | `return_elapsed_ms`, `delivery_attempt_bucket` |
| `feature_used` | An Owner or collaborator completes an allowlisted feature action | `feature` enum, `actor_kind` enum (`owner`, `collaborator`), `episode_phase` when applicable |
| `observability_setting_changed` | Owner confirms an observability setting change | `setting` enum, `enabled`, `policy_version`; never content or a collaborator identity |

Every event also carries the common resource fields,
`coloop.installation.telemetry_id`, optional
`coloop.episode.telemetry_id`, optional `coloop.operation.id`, and
`event.schema.version=1`. Use the installation telemetry ID as PostHog's
`distinct_id`; do not call `identify()` with an Owner profile and do not set email,
name, Discord ID, or person properties.

Recommended buckets prevent quasi-identifying exact values where precision has no
product value:

- collaborator count: `1`, `2`, `3_plus`;
- Context Package bytes: `lt_8k`, `8k_32k`, `32k_128k`, `gte_128k`;
- accepted turns: `0`, `1_3`, `4_10`, `11_plus`;
- attempts: `1`, `2`, `3_plus`;
- durations: fixed product buckets documented with the schema.

`feature_used.feature` starts with only shipped values. Unknown feature names are
rejected, not forwarded. Do not capture page views, clicks, every Discord message,
every Agent span, or every retry as product events. Agent spans and operational
signals already serve those purposes.

### Structured operational log inventory

The log body is exactly the fixed `event.name`; all detail is typed attributes. No
template interpolation or free-form exception message is exported.

| `event.name` | Severity | Emit when | Required safe attributes |
| --- | --- | --- | --- |
| `runtime.started` | INFO | Process initializes | `restart_kind`, `service.version` |
| `runtime.readiness_changed` | INFO/WARN/ERROR | Overall status changes | `from`, `to`, `reason_class` |
| `gateway.state_changed` | INFO/WARN | Gateway state changes | `from`, `to`, `resume_possible`, `close_code_class` |
| `gateway.resume_completed` | INFO/WARN | Resume or re-identify completes | `mode`, `result`, `elapsed_ms`, `replayed_event_bucket` |
| `reconciliation.completed` | INFO/ERROR | Startup/disconnect reconciliation ends | `result`, `elapsed_ms`, `input_count_bucket`, `duplicate_count_bucket`, `pending_action_bucket` |
| `provider.attempt_completed` | INFO/WARN/ERROR | Provider-facing attempt ends | `provider`, `operation`, `result`, `elapsed_ms`, `attempt_bucket`, `error.type`, `retry_scheduled` |
| `inbox.item_completed` | INFO/WARN | Accepted input completes or is suppressed | `result` enum (`completed`, `duplicate`, `retryable`, `quarantined`), `attempt_bucket` |
| `delivery.state_changed` | INFO/WARN/ERROR | Outbound action changes state | `action_kind`, `from`, `to`, `attempt_bucket`, `error.type` |
| `sqlite.health_check_completed` | INFO/ERROR | Startup/scheduled check ends | `check_kind`, `result`, `elapsed_ms`, `database_size_bucket`, `wal_size_bucket` |
| `sqlite.busy_observed` | WARN | An operation exhausts its busy wait | `operation_class`, `wait_bucket` |
| `cleanup.run_completed` | INFO/WARN/ERROR | Cleanup pass ends | `result`, `deleted_count_bucket`, `overdue_count_bucket`, `oldest_overdue_age_bucket` |
| `quota.threshold_crossed` | WARN/ERROR | Configured spend/quota threshold crosses | `provider`, `threshold` enum (`80_percent`, `100_percent`), `source` enum (`provider`, `estimated`) |
| `telemetry.export_state_changed` | WARN/ERROR/INFO | Export becomes failing or recovers | `signal`, `from`, `to`, `error.type`, `dropped_count_bucket` |

Common log attributes are `event.schema.version`, time, severity,
`service.name`, `service.version`, `deployment.environment.name`, runtime mode,
installation telemetry ID, and optional Episode/operation/trace/span correlation.
`error.type` is one of a reviewed set such as `timeout`, `rate_limited`,
`authentication`, `permission`, `invalid_request`, `provider_unavailable`,
`database_busy`, `database_corrupt`, `network`, `export_rejected`, or `unknown`.

PostHog recommends structured, outcome-oriented logs, sampling routine successes,
and omitting request/response payloads. Its log PII scrubber is opt-in,
non-retroactive, best-effort, and explicitly not a replacement for source
redaction. [PostHog Logs pricing and logging guidance](https://posthog.com/docs/logs/pricing),
[PII scrubbing](https://posthog.com/docs/logs/pii-scrubbing)

### Application metric inventory

Metric attributes are drawn only from bounded enums named below. Resource attributes
on metric points are limited to environment, runtime mode, service name, and at most
two active service versions. No telemetry installation/Episode/operation/trace ID is
a metric attribute.

| Metric | Instrument/unit | Attributes | Purpose |
| --- | --- | --- | --- |
| `coloop.runtime.uptime` | observable gauge, `s` | none | Distinguish a live process from a recent restart locally; remote absence is not a reliable v0 alert. |
| `coloop.gateway.connected` | observable gauge, `1` | none | Current Gateway usability (`0` or `1`). |
| `coloop.gateway.heartbeat.rtt` | histogram, `ms` | `result` | Gateway latency and missing ACK diagnosis; do not log every heartbeat. |
| `coloop.gateway.reconnects` | counter, `{attempt}` | `mode`, `result`, `reason_class` | Reconnect/resume stability. |
| `coloop.reconciliation.runs` | counter, `{run}` | `trigger`, `result` | Restart/disconnect reconciliation outcomes. |
| `coloop.reconciliation.duration` | histogram, `ms` | `trigger`, `result` | Reconciliation lag. |
| `coloop.provider.requests` | counter, `{request}` | `provider`, `operation`, `result`, `error.type` | Explicit provider failures and rate limits outside or around Agent tracing. |
| `coloop.provider.request.duration` | histogram, `ms` | `provider`, `operation`, `result` | Provider boundary health. |
| `coloop.delivery.pending` | observable gauge, `{action}` | `action_kind` | Current pending outbox actions. |
| `coloop.delivery.oldest_pending.age` | observable gauge, `s` | `action_kind` | Detect stuck Outcome/Discord delivery. |
| `coloop.delivery.attempts` | counter, `{attempt}` | `action_kind`, `result` | Retry pressure and final acknowledgement. |
| `coloop.sqlite.busy` | counter, `{occurrence}` | `operation_class` | Write contention. |
| `coloop.sqlite.operation.duration` | histogram, `ms` | `operation_class`, `result` | Database latency without SQL text. |
| `coloop.sqlite.database.size` | observable gauge, `By` | none | Unexpected growth. |
| `coloop.sqlite.wal.size` | observable gauge, `By` | none | Checkpoint starvation/growth. |
| `coloop.sqlite.quick_check` | observable gauge, `1` | none | Last check result (`1` healthy, `0` unhealthy). |
| `coloop.cleanup.overdue` | observable gauge, `{artifact}` | `artifact_kind` | Restricted artifacts beyond their deadline. |
| `coloop.cleanup.oldest_overdue.age` | observable gauge, `s` | `artifact_kind` | Severity of cleanup lag. |
| `coloop.telemetry.export.failures` | counter, `{failure}` | `signal`, `error.type` | Exporter health. |
| `coloop.telemetry.dropped` | counter, `{item}` | `signal`, `reason_class` | Queue overflow, rejection, and sampling loss. |
| `coloop.telemetry.queue.utilization` | observable gauge, `1` | `signal` | Bounded queue pressure (`0.0`–`1.0`). |

Do not emit duplicate Agent OTel metrics in v0. The Agent dashboard reads tokens,
latency, errors, and approximate cost from the settled PostHog full-trace stream.
Exact cost remains a trace-derived value because provider prices change and OTel
does not define a stable cost metric. A future portable projection may adopt the
development-stage GenAI names above, but it is not part of the application-safe
schema or this Collector pipeline.

SQLite's `quick_check` is an O(N) reduced integrity check, while `wal_checkpoint`
reports WAL/checkpoint progress. SQLite automatically checkpoints around 1,000 WAL
pages by default, but long readers or disabled/deferred checkpoints can allow the WAL
to grow. These facts justify health checks and size/lag metrics, not a remote recovery
dependency. [SQLite PRAGMA reference](https://www.sqlite.org/pragma.html), [WAL
documentation](https://www.sqlite.org/wal.html)

### Application spans

Application tracing is intentionally narrow. One Owner-local process does not need a
span around every function.

```text
episode.open
  sqlite.transition
  discord.thread.create
  sqlite.activate

episode.turn
  discord.receive
  sqlite.inbox.claim
  episode.agent.invoke        opaque application boundary
  sqlite.reply.enqueue
  discord.reply.deliver
  sqlite.reply.acknowledge

episode.finalize | episode.cancel
  sqlite.transition
  discord.control.deliver

episode.outcome.return
  sqlite.outbox.claim
  origin.outcome.deliver
  sqlite.outbox.acknowledge

runtime.reconcile
  discord.resume_or_fetch
  sqlite.inbox.reconcile
  sqlite.outbox.reconcile
```

Span attributes use only operation names, result/error enums, attempt buckets,
durations inherent in spans, and safe correlation IDs. Do not put SQL, Discord text,
Opening Brief, Context Package, Outcome Proposal, Episode Outcome, provider request
or continuation IDs, tool values, headers, paths, or raw errors on application
spans.

The opaque application span answers causal latency and retry questions across the
Agent boundary without copying the Agents SDK subtree. The settled full Agent trace
trial separately answers model/tool quality questions and bypasses the application
Collector. The two streams join only on the safe Episode/operation telemetry IDs;
neither requires the other's trace ID. PostHog's AI OTel documentation demonstrates
why the lanes must remain distinct: its AI endpoint accepts only traces, maps common
`gen_ai.*` attributes to PostHog AI properties, drops non-AI spans, and imposes an
AI-specific request limit. This application-wide observability design does not
reimplement that endpoint contract or the already-settled trial integration.
[PostHog OTel AI
installation](https://posthog.com/docs/ai-observability/installation/opentelemetry)

### Signals intentionally omitted from v0

- Heartbeat-by-heartbeat logs, SQL statement logs, debug spans around internal
  functions, CPU profiles, heap profiles, host inventory, and network packet data.
- Discord message count as a product event; accepted-turn buckets at terminal
  milestones are enough.
- Owner/collaborator profiles, cohort demographics, Discord server analytics,
  browser/session replay, autocapture, GeoIP, and marketing attribution.
- Success/failure dashboards per individual Owner, collaborator, Discord thread,
  Episode ID, provider response ID, or exact prompt.
- A durable telemetry outbox, telemetry replay, or backfill from SQLite.
- An external uptime/paging service for Owner-local v0. Hosted operation can add one
  when [Define v0 observability and operational ownership](https://github.com/rajat2006/coloop/issues/22)
  assigns an on-call owner.

## Export topology

```text
Coloop owner-local process
  |
  |-- SQLite domain/recovery state --------------------> authoritative local DB
  |
  |-- ProductAnalytics port ---------------------------> PostHog capture API
  |
  |-- JSON operational logger -------------------------> stderr / capped local ring
  |          |
  |          `-- safe log records --.
  |
  |-- OTel application tracer/meter -----.              |
  |                                       |              |
  |                                       `--> safe application telemetry adapter
  |                                            positive allowlist + schema v1
  |                                                     |
  |                                                     v
                                  managed local OTel Collector
                                  memory limit + redaction + batch
                                     |        |         |
                                     |        |         `--> PostHog Metrics (alpha)
                                     |        `------------> PostHog Logs
                                     `---------------------> PostHog general traces
  |
  `-- settled Agents SDK full-trace integration ---------> PostHog AI
      separate consented stream; safe Episode/operation IDs only

Collector or PostHog unavailable
  --> bounded retry/drop, local warning, SQLite/Discord/Agent behavior unchanged
```

The safe application stream exports OTLP to `127.0.0.1`, not directly to PostHog's
distinct operational-signal endpoints. The Collector is a pinned, Coloop-managed
child/sidecar for the trial: the Owner does not configure, upgrade, query, or recover
through it. It owns operational authentication headers, endpoint differences,
batching, bounded retry, and a second redaction allowlist. Fan-out or an operational
backend change is then a Collector configuration change, not a domain-code change.
The already-settled Agent integration is outside it. OTel documents a local debug
exporter for development and recommends the Collector for production export.
[OpenTelemetry JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/)

The two trace pipelines are intentionally not merged into one schema. The settled
Agent stream may contain the full trace content permitted by the private trial. The
application stream is always the safe schema in this report. They share only random
Coloop Episode/operation telemetry IDs, so disabling or deleting the full Agent
stream does not remove application health, and enabling it does not widen
application logs/spans.

The Collector's in-memory sending queue and retry behavior can still drop data when
the queue fills or the retry deadline expires. A file-backed queue can survive a
Collector restart but still loses data on disk failure, exhaustion, or a prolonged
outage. Use an in-memory queue for Owner-local v0: observability loss is acceptable,
whereas a telemetry WAL would create another sensitive durable store to operate.
[OpenTelemetry Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/)

## Backend decision

### Option comparison

| Topology | Product/Agent fit | Operational maturity | Cost and operations | Exit/correlation | Verdict |
| --- | --- | --- | --- | --- | --- |
| **PostHog Cloud for all remote signals** | Best combined product funnel + Agent trace/eval context; one project and UI | OTLP Logs and five-minute count alerts are usable; general tracing beta; metrics alpha and documented mainly as viewer/SQL | Published free allowances cover 1M analytics events, 100k AI events, and 10 GB logs monthly; one free project. General trace/metric price/allowance is not stated on the current public pricing list, so verify before enabling billing. | OTel/OTLP for ops, app-owned IDs, Collector fan-out; product events remain PostHog-shaped | **Choose for bounded v0 trial.** Fewest services and enough evidence to judge the combined value. |
| **PostHog Product/AI + Grafana Cloud operations** | Keeps PostHog's strongest surfaces | Mature managed metrics/logs/traces, dashboards, and alerting; strong OTel/Prometheus/Loki/Tempo ecosystem | Grafana's current Free plan advertises 50 GB/month and 14-day retention, with its detailed price list also describing metric series and logs/traces units. Adds a second account, token, UI, access policy, and deletion surface. | Excellent OTel portability; same app-owned correlation IDs must be queried in two tools | **Leading fallback.** Split when a required operational query/alert or published price gate fails in PostHog. |
| **PostHog Product/AI + SigNoz Cloud operations** | Same split | OTel-native logs/metrics/traces and alerts on each signal | Current Teams Cloud starts at $49/month including usage; Community self-host transfers storage, backup, upgrade, and access burden to Coloop | Strong OTel alignment and single operational UI | Credible, but worse v0 economics than Grafana Free and too much self-host burden. |
| **Self-host PostHog/SigNoz/Grafana stack** | Varies | Capability can be strong | Owner must operate storage, backup, availability, upgrades, access, and deletion for the observability system | Maximum infrastructure control, maximum burden | Reject for Owner-local v0. Local diagnostics provide control without running a platform. |

Sources: [PostHog pricing](https://posthog.com/pricing), [Grafana Cloud pricing](https://grafana.com/pricing/?tab=free),
[Grafana Cloud overview](https://grafana.com/docs/grafana-cloud/learn-and-build/get-started/learn/),
[SigNoz overview](https://signoz.io/docs/what-is-signoz/), [SigNoz pricing](https://signoz.io/pricing/)

### Why one remote backend wins initially

Owner-local v0 has one process, one Owner, and low event volume. A second remote
backend would not improve Episode recovery, would double privacy/deletion/access
work, and would make cross-signal diagnosis slower before Coloop knows which
operational queries matter. PostHog's immature products are optional views, not the
source of readiness or alerts required for safe local behavior.

The recommendation is therefore deliberately narrower than “standardize on PostHog”:

1. Standardize on the Coloop schema and OTel transport.
2. Trial PostHog as the single remote reader.
3. Depend on local diagnostics for immediate Owner action.
4. Split only on measured insufficiency.

PostHog documents OTLP ingest but not general OTLP egress. Its batch exports emit
PostHog's event model to data destinations, not a lossless round-trip OTel stream.
Fan-out before ingestion and retain the schema in code; never treat vendor export as
the exit plan. [PostHog batch exports](https://posthog.com/docs/cdp/batch-exports)

## Minimum views

### Dashboard 1: product activation and value

- Installation activation → Owner Pairing → Episode opened → Episode activated
  funnel.
- Activated Episodes that finalize versus cancel.
- Finalized Episodes whose Outcome returns successfully.
- Time from opening to activation and active duration buckets.
- Feature use and observability-setting adoption by service version.

North-star candidate for the trial: **Collaboration Episodes with a returned Episode
Outcome per activated installation**, shown alongside cancellation and return
failure. Do not optimize raw message, turn, trace, or token volume as product value.

### Dashboard 2: Episode reliability and delivery

- Opening activation latency and failure classes.
- Reconciliation run results/duration and duplicate-suppression counts.
- Provider request results, retry count, rate limits, and p95 duration.
- Pending Discord/Origin actions and oldest pending age.
- Outcome return acknowledgement rate.
- Version markers for regressions.

### Dashboard 3: Agent efficiency and runtime health

- Agent invocation/turn/generation counts, p50/p95 duration, input/output/cache
  tokens, approximate cost, error type, tool/handoff counts by model and release.
- Gateway connection, heartbeat RTT, reconnect/resume results.
- SQLite busy count, operation p95, database/WAL size, last quick-check status.
- Cleanup overdue count/age.
- Telemetry export failures, dropped items, and queue utilization.

PostHog AI Observability already exposes cost, latency, token, error, volume, and
evaluation views. Coloop should join them using its safe telemetry IDs rather than
duplicating every Agent span into product analytics. [PostHog AI
Observability](https://posthog.com/docs/ai-observability)

## Minimum alerts

Remote alerts are a convenience for the private trial. Any condition that can make
the local runtime unsafe or unusable must also be visible from stderr and the local
diagnostic snapshot because the process or exporter may be down.

| Condition | Threshold for the trial | Surface | Owner action |
| --- | --- | --- | --- |
| SQLite unavailable/migration/quick-check failure | Any occurrence | Immediate local ERROR and blocked readiness; remote log if export works | Stop accepting work; preserve DB files; run documented diagnosis/repair, not automatic destructive repair. |
| Gateway unhealthy | No ACK by the next negotiated heartbeat attempt, or disconnected for two intervals | Immediate local degraded status; aggregate dashboard | Reconnect/resume automatically; Owner inspects if it persists. Discord itself requires reconnect after a missing ACK. |
| Gateway reconnect loop | 3 failed reconnect/resume attempts in 10 min | PostHog log-count alert + local WARN | Check network/token/Discord status and reconciliation state. |
| Reconciliation stuck | One run older than 5 min or any quarantined item | Local ERROR + remote log alert | Inspect content-free inbox/outbox status; do not replay from telemetry. |
| Pending delivery stuck | Oldest pending action >5 min, or 3 failed attempts | Local WARN/ERROR + remote alert | Inspect provider availability and the recovery outbox; preserve idempotency. |
| Provider failure burst | 3 consecutive failures or >20% over 15 min with at least 5 requests | Remote log alert + local status | Inspect error class/rate limit; back off, do not change Episode Phase. |
| Spend/quota risk | Configured provider budget estimate/provider quota reaches 80%, then 100% | Local + remote WARN/ERROR | Owner decides whether to stop new Agent work; approximate trace cost never automatically authorizes spend. |
| Cleanup overdue | Any Context Package >1 hour beyond its selected deletion deadline | Local ERROR + remote alert | Retry cleanup, report affected artifact count, and follow the final policy from [Define episode record retention audit and deletion](https://github.com/rajat2006/coloop/issues/20). |
| Telemetry broken | Any drop, or export continuously failing for 15 min | Local WARN only plus diagnostic counter; recovery notice after exporter resumes | Continue Episodes; fix configuration/network later. A remote system cannot reliably alert on its own missing path. |

PostHog log alerts check every five minutes and support thresholds over 5–60 minute
windows with Slack, Microsoft Teams, or webhook destinations. Those constraints mean
they are suitable for trend/burst alerts above, not heartbeat liveness or sub-minute
readiness. [PostHog log alerts](https://posthog.com/docs/logs/alerts)

Do not alert in v0 on a single cancellation, feature-use decline, individual slow
Agent turn, exact token count, database size alone, a sampled successful trace, or
the absence of remote telemetry. Those are dashboard or diagnostic inputs.

## Local diagnostics

The dependable v0 surface is a content-free `coloop diagnostics --json` equivalent
and human-readable rendering. The exact command name is an implementation choice;
the contract is:

```json
{
  "generated_at": "UTC timestamp",
  "service_version": "release",
  "runtime_mode": "owner_local",
  "status": "healthy | degraded | blocked",
  "gateway": {
    "state": "connected | reconnecting | disconnected",
    "last_ack_age_ms": 0,
    "reconnect_attempts": 0,
    "reconciliation_state": "idle | running | blocked"
  },
  "episodes": {
    "nonterminal_count": 0,
    "interrupted_run_count": 0
  },
  "delivery": {
    "pending_count": 0,
    "oldest_pending_age_s": 0,
    "quarantined_count": 0
  },
  "sqlite": {
    "open": true,
    "schema_version": 0,
    "last_quick_check": "ok | failed | never",
    "database_bytes": 0,
    "wal_bytes": 0,
    "busy_count_since_start": 0
  },
  "cleanup": {
    "overdue_count": 0,
    "oldest_overdue_age_s": 0
  },
  "provider": {
    "last_result": "ok | rate_limited | unavailable | auth_failed | unknown",
    "estimated_budget_ratio": null
  },
  "telemetry": {
    "mode": "off | local | posthog",
    "agent_trace_trial": "inactive | active | export_failed",
    "last_export_result": "ok | failed | never",
    "dropped_since_start": 0,
    "queue_utilization": 0.0
  }
}
```

The snapshot contains counts, age, enums, and presence—not Episode, Discord,
provider, path, content, or hash values. A separate, Owner-invoked support bundle may
include this snapshot, release/config-presence manifest, and the last 24 hours of
sanitized local logs. It excludes the SQLite file, Context Package, environment
variable values, credentials, raw stack traces, Discord text, Agent content, Outcome
Proposal, and Episode Outcome.

## Configuration and governance

### Environment separation

- `development`: remote export off by default; JSON stderr plus local Collector
  debug exporter. Developer may explicitly target a disposable sandbox project.
- `test`: remote export disabled unconditionally. Tests use an in-memory capture
  adapter and fail if any real exporter is constructed.
- `staging`: no remote data for Owner-local v0. If introduced later, use a separate
  vendor project and synthetic content only.
- `production`: the dedicated private-trial PostHog project only.

The PostHog Free plan currently includes one project and one-year general data
retention; pay-as-you-go raises the project count to six. Do not mix development or
test telemetry into the one production trial project merely to stay free. [PostHog
pricing](https://posthog.com/pricing)

Recommended configuration surface:

```text
COLOOP_TELEMETRY_MODE=off|local|posthog
COLOOP_TELEMETRY_LOG_LEVEL=info
COLOOP_TELEMETRY_SUCCESS_TRACE_RATIO=1.0
COLOOP_PROVIDER_BUDGET_USD=<optional Owner-selected amount>

OTEL_SERVICE_NAME=coloop-bridge
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.version=<release>
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318

POSTHOG_HOST=https://us.i.posthog.com|https://eu.i.posthog.com
POSTHOG_PROJECT_TOKEN=<secret>
```

The Agent integration settled by [Research the Episode event journal and
observability storage](https://github.com/rajat2006/coloop/issues/28) retains its own
consent, participant-disclosure, project/region, and kill-switch preconditions.
Application telemetry observes only the coarse trial status shown above; it neither
implements a second capture-mode gate nor changes the settled full-trace shape.

### Sampling

| Signal | Owner-local v0 policy |
| --- | --- |
| Product events | 100%; they are few and are the analytics record of intentional milestones. |
| ERROR/WARN operational logs | 100%. |
| INFO state-change/summary logs | 100% during the bounded trial; never emit per-heartbeat or per-poll INFO records. |
| DEBUG logs | Local only and off by default; never remote. |
| Application traces | 100% during the small trial, except routine health checks are not traced. |
| Agent traces | 100% full capture for the assumed private trial; this is a trial exception, not a standing hosted default. |
| Metrics | Do not sample; aggregate in process and export every 60 seconds. |

If a hosted runtime later exceeds 10,000 successful Episode turns/month, retain all
errors and traces over a selected slow threshold, and start with a 10% deterministic
sample of routine successes. OTel JS supports deterministic trace-ID ratio head
sampling, but preserving errors based on final outcome requires Collector tail
sampling; that operational change is unnecessary for v0. [OpenTelemetry JavaScript
sampling](https://opentelemetry.io/docs/languages/js/sampling/)

### Cardinality limits

- Maximum 200 active application metric series per process and 20 series per custom
  Coloop metric. Stop creating new series, increment
  `coloop.telemetry.dropped{reason_class="cardinality_limit"}`, and warn locally when
  reached.
- Metric attributes use only enumerated `provider`, `operation`, `result`,
  `error.type`, `mode`, `trigger`, `action_kind`, `artifact_kind`, and at most two
  active release values.
- Normalize unknown providers, models, close codes, and error subclasses to
  `other`/`unknown`; exact safe model names may remain on traces, not metric series.
- High-cardinality telemetry IDs exist only on product events, logs, and traces.
- No URL, route with IDs, SQL, filename, hostname, stack frame, or exception text is
  a metric label.

PostHog's own metrics docs warn that each attribute value creates a new series and
say never to attach user IDs. Its SDK guardrail defaults to 1,000 series per flush;
Coloop's tighter process-wide limit reflects its much smaller v0 topology. [PostHog
application metrics](https://posthog.com/docs/metrics)

### Redaction and data classification

| Classification | Examples | Export rule |
| --- | --- | --- |
| Forbidden secrets | Discord/OpenAI/PostHog tokens, authorization/cookie headers, credentials, environment values | Never enter telemetry objects. |
| Restricted recovery state | Provider continuation IDs, Discord/thread/message IDs, Gateway session/sequence, inbox payload/hash, outbox payload/idempotency key, serialized `RunState`, Context Package path/content, Episode Outcome | Never exported. Presence/count/result only. |
| Restricted conversation | Opening Brief, collaborator messages, Agent replies, prompts, tool inputs/outputs, Outcome Proposal | Only the fields already included by the assumed full Agent trace trial, in the dedicated private-trial project. Never duplicate into product events, operational logs, application metrics/spans, or support bundles. |
| Pseudonymous metadata | Installation/Episode/operation telemetry IDs, trace IDs, lifecycle/result enums, token counts, duration, model, version | Export according to signal retention/access rules. Still treated as linkable data. |
| Aggregate health | Counts, histograms, gauges with bounded labels | Exportable by default after Owner telemetry opt-in. |

Enforce privacy at three layers:

1. Typed application constructors accept only the documented fields and reject
   unknown attributes.
2. The Collector redaction processor allowlists attributes; filter/transform rules
   remove anything disallowed before network export.
3. Enable PostHog Logs PII scrubbing as defense in depth, while assuming it will miss
   unknown formats.

OpenTelemetry says the implementer is responsible for sensitive-data decisions and
recommends not collecting sensitive data in the first place. Its Collector offers
attribute, filter, redaction, and transform processors. GenAI input/output fields are
explicitly likely to contain sensitive information. [OpenTelemetry sensitive-data
guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/), [GenAI
attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

Build negative tests with sentinel values in every forbidden category. Inspect the
serialized OTLP request and PostHog capture payload—not merely the in-memory object—
and fail on any sentinel, unknown key, raw ID pattern, path, message, Outcome, or
credential.

### Retention

| Data | v0 retention |
| --- | --- |
| Local structured logs | Capped ring: 7 days or 50 MiB, whichever comes first. [Define episode record retention audit and deletion](https://github.com/rajat2006/coloop/issues/20) may shorten this; recovery never reads it. |
| Owner-generated support bundle | Owner deletes after the support exchange; tooling warns at 7 days. No automatic upload. |
| PostHog Logs | Default 14 days; do not buy 30-day extension for v0. PostHog documents the extension at $0.05/GB. [Logs pricing](https://posthog.com/docs/logs/pricing) |
| Full Agent trace large content properties | PostHog removes the listed large `$ai_*` properties after 30 days; end/destroy the dedicated trial project sooner if the consented trial ends first. [AI data retention](https://posthog.com/docs/ai-observability/data-retention) |
| Trimmed AI metadata and product analytics | Dedicated trial project only; delete the project at the end of the bounded trial. If ongoing metadata-only use is approved later, one-year maximum on the Free plan. |
| General application traces and metrics | Trial only; treat as disposable and delete with the project. Their current public docs do not state a separate retention guarantee, so do not promise one. |

The 7-day local log window is a concrete recommendation for this signal design, but
[Define episode record retention audit and deletion](https://github.com/rajat2006/coloop/issues/20)
owns the final cross-store deletion schedule. A later decision may shorten the ring
without changing recovery.

### Access and deletion

- Use one dedicated PostHog project for the private trial and the selected US/EU
  region. Membership is the Owner and at most one named maintainer/reviewer.
- Store only the project ingestion token on the Owner's machine, in the selected OS
  secret boundary. Do not install a PostHog personal API key in the runtime.
- Do not batch-export or copy full Agent traces into a warehouse.
- The local kill switch stops new export immediately and records a local-only state
  change. Disabling capture does not claim to erase data already sent.
- At trial end, disable export first, flush/drop the bounded queue, delete the
  dedicated PostHog project, and record completion locally without copying its data.
- For an installation deletion in a future shared hosted project, delete product
  persons/events by installation telemetry ID and separately prove deletion for
  logs/traces/metrics. Until that proof exists, do not promise per-install deletion
  from a shared observability project.

PostHog documents project deletion as removing all project data, person/event
deletion as asynchronous, regional Cloud storage, and project-level raw-IP discard.
Because it does not publish one exact completion SLA for every signal on that page,
the validation must observe deletion behavior before any hosted promise. [PostHog
data storage and deletion](https://posthog.com/docs/privacy/data-storage)

### Failure and outage behavior

1. Construct telemetry after recovery configuration/SQLite initialization, and
   isolate every capture call so it cannot throw into domain code.
2. Commit SQLite/domain changes first. Enqueue telemetry only after commit; a failed
   transaction emits no success milestone.
3. Use bounded in-memory application and Collector queues. When full, drop newest
   telemetry, increment a local dropped counter, and emit one rate-limited local
   warning.
4. Retry transient export failures with bounded exponential backoff. Do not retry
   permanent authentication/schema/4xx rejection until configuration changes.
5. Never write telemetry to the recovery outbox and never backfill from audit,
   inbox, outbox, or Episode tables.
6. On graceful shutdown, attempt a maximum two-second asynchronous flush after
   stopping new captures. Exit even if it fails.
7. On Collector/PostHog outage, product and Agent behavior continues. The local
   diagnostic separately shows the application export result and coarse Agent-trial
   status; remote gaps and duplicates are acceptable.
8. On startup with missing/invalid PostHog configuration, issue one local warning,
   switch application remote export off, and continue. The separate Agent
   integration applies its already-settled consent/config preconditions and reports
   its coarse status; application telemetry does not activate or reshape it.

OTLP permits retry after ambiguous acknowledgement and therefore duplicate
telemetry; Collector queues can overflow or age data out. These are suitable
semantics for diagnosis, not Episode recovery. [OTLP specification](https://opentelemetry.io/docs/specs/otlp/),
[Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/)

## Developer experience

The minimum developer loop is:

1. Run Coloop with `COLOOP_TELEMETRY_MODE=local`.
2. Run one local Collector configuration with OTLP receiver, memory limiter,
   redaction allowlist, batch processor, and debug exporter.
3. See sanitized JSON logs on stderr and traces/metrics/log records in Collector
   debug output.
4. Run contract tests against the in-memory adapter and serialized OTLP payloads.
5. Opt into a disposable PostHog sandbox only for integration tests; never use the
   production trial token locally by default.

The application-wide stream needs one telemetry package, one Collector
configuration, and one safe schema contract. It does **not** need a local
PostHog/Grafana/SigNoz service. Its PostHog product-event adapter is one
vendor-specific boundary; the settled Agent-to-PostHog integration is the other,
separate boundary. Operational vendor settings stay in Collector configuration.

Pin and test the OTel application semantic-convention mapping because PostHog's
metrics/tracing endpoints are not stable. A version bump changes the adapter, not
domain call sites. A GenAI projection is deferred unless the Agent stream later
needs a portable backend.

## Expected Cloud cost

### Owner-local v0 trial model

Use a deliberately conservative monthly envelope for one Owner:

| Input | Assumption |
| --- | --- |
| Collaboration Episodes | 100/month |
| Accepted Agent turns | 10/Episode = 1,000/month |
| Product events | <=10/Episode plus setup = <=1,100/month |
| AI events/spans | <=20/turn = <=20,000/month |
| Sanitized logs | <=50 KiB/Episode plus runtime summaries = <10 MiB/month |
| General application spans | <=12/turn plus lifecycle = <15,000/month |
| Metric series | <=200, one point/minute = <=8.64M points/month |

Published PostHog allowances make Product Analytics, AI Observability, and Logs
**$0/month** at that envelope: 1M analytics events, 100k AI events, and 10 GB logs
per month. Product Analytics beyond its free allowance currently starts at
$0.00005/event; Logs beyond 10 GB starts at $0.25/GB through 300 GB. [PostHog
pricing](https://posthog.com/pricing), [Logs pricing](https://posthog.com/docs/logs/pricing)

The current public pricing page does not list a separate allowance or rate for
general distributed traces or application metric points. Because those products are
beta/alpha, the honest v0 estimate is:

- expected invoice: **$0/month** under a no-card Free trial;
- approved ceiling after adding billing: **$10/month** for observability, enforced by
  product billing limits;
- decision blocker: any unpriced metric/trace usage, inability to set a hard cap, or
  measured projection above the ceiling.

Do not interpret the $0 estimate as a permanent hosted cost. At 100 similar Owners,
the model projects about 2M AI events/month and crosses the published AI free tier,
while access control, alerting, and retention requirements also change. Re-price from
measured bytes/events/series before hosted rollout.

If the split gate fires, Grafana Cloud's current Free plan is also expected to cost
$0 for this sanitized operational volume, but introduces the second-backend labor
described earlier. SigNoz Cloud's current Teams minimum makes its expected invoice
$49/month even at low volume. [Grafana pricing](https://grafana.com/pricing/?tab=free),
[SigNoz pricing](https://signoz.io/pricing/)

## Owner-local to hosted migration

This design migrates without changing domain call sites or making a general
multi-tenant design:

1. Keep event names, OTel instruments, attribute enums, telemetry ID generation, and
   schema versions unchanged.
2. Replace the local Collector with a hosted gateway Collector that enforces the
   same allowlist before vendor fan-out. Applications still export OTLP.
3. Set `coloop.runtime.mode=hosted`, add a hosted service instance identifier to
   traces/logs only, and separate production/staging vendor projects.
4. Keep installation telemetry ID as PostHog's pseudonymous product identity. Do not
   add an Owner/tenant label to metrics. A future hosted trust decision must define
   tenant isolation before shared infrastructure, but this report does not design it.
5. Add external process/endpoint uptime monitoring and a real on-call destination
   only when [Define v0 observability and operational ownership](https://github.com/rajat2006/coloop/issues/22)
   assigns operational ownership.
6. Migrate recovery persistence from SQLite to hosted Postgres separately, as
   [Research the Episode event journal and observability storage](https://github.com/rajat2006/coloop/issues/28)
   describes. Do not copy SQLite content into PostHog and do not use telemetry to
   validate or replay the migration.
7. Start a new hosted telemetry retention/access policy and project. Do not carry the
   full-content private-trial project forward.

The app-owned correlation IDs let a hosted worker, Agent trace, and delivery log join
without Discord/provider identifiers. The Collector seam lets operational signals
move to Grafana/SigNoz without changing Episode code. Neither choice solves hosted
database backup, tenancy, encryption, or support ownership.

## Bounded real-use validation

Run the trial for the earliest of **30 days, 30 consenting real Collaboration
Episodes, or 300 accepted Agent turns**, on one Owner installation and its dedicated
PostHog project. Use no more than five named collaborators and display the existing
full-trace disclosure in every affected Episode.

### Before real use

- Schema tests enumerate every accepted/rejected event and attribute.
- Sentinel tests cover credentials, Context Package, Opening Brief, Discord text,
  Agent reply, tool data, Outcome Proposal, Episode Outcome, raw IDs, hashes, paths,
  provider errors, and serialized `RunState`.
- Failure injection covers Collector absent, DNS/network cut, invalid PostHog token,
  4xx rejection, queue overflow, process crash, shutdown
  flush timeout, and project billing limit.
- Recovery comparison proves identical SQLite rows, Discord effects, Agent results,
  and Outcome delivery with telemetry `off`, `local`, and failing `posthog` modes.
- Synthetic operations exercise every dashboard and alert threshold, including alert
  firing, recovery, and broken evaluation visibility.

### During the real trial

For each real Episode, record only review findings—not copied content—in a trial
scorecard:

- Could the Owner/maintainer explain opening, Agent, and Outcome-return latency in
  under five minutes?
- Did product milestones agree with the durable phase/outbox state for sampled
  Episodes, allowing for explicitly lost telemetry?
- Did a full Agent trace produce an actionable Agent/product improvement unavailable
  from metadata and ordinary Discord inspection?
- Were gateway/reconciliation/provider/delivery failures diagnosable without opening
  raw SQLite tables?
- What events, log bytes, spans, metric series/points, dropped items, and projected
  monthly price did the installation generate?
- Did any query require a raw identifier, content field, or unbounded label? If so,
  reject the query rather than expanding the schema silently.

### Seven-day split benchmark

For one week, fan out **sanitized operational OTLP only** to a Grafana Cloud Free
stack. Do not send the full Agent content lane or duplicate product analytics. Rebuild
Dashboard 2 and the non-Agent half of Dashboard 3, then compare:

- time to construct and understand the views;
- alert expressiveness and delivery;
- query latency and correlation from a safe trace ID to logs;
- retention/deletion/access administration;
- ingest units and projected cost;
- setup and maintenance time.

This is a backend decision experiment, not a permanent second production dependency.

### Acceptance gates

Keep PostHog as the single remote v0 backend only if all are true:

1. All forbidden-field tests pass at serialized network payload boundaries.
2. Telemetry outage/failure changes no Episode Phase, recovery row, Agent result,
   Discord delivery, or Outcome return behavior.
3. At least 90% of injected operational incidents are diagnosable from the local
   snapshot plus PostHog metadata within five minutes.
4. Required burst alerts fire and resolve within ten minutes; immediate local
   readiness/cleanup/SQLite warnings do not depend on them.
5. The three minimum dashboards can be maintained without undocumented PostHog
   internals or product-event copies of logs/metrics.
6. Agent traces contribute at least two concrete improvements that metadata and
   normal testing did not reveal; otherwise end full content capture even if the
   operational backend remains.
7. General trace/metrics billing and retention are verified in the actual account,
   the projected invoice stays under $10/month, and a hard billing limit works.
8. Project deletion is exercised on a disposable sandbox and its visible completion
   is recorded before promising trial teardown.
9. The Collector can route the same sanitized operational fixture to Grafana without
   application code or schema changes.

Split operational telemetry to Grafana Cloud if any required PostHog metric/trace
query or alert cannot be expressed, if alpha/beta changes break it twice during the
trial, if price/retention remains undocumented in the account, or if the Grafana
benchmark materially reduces diagnosis/alert effort. Choose SigNoz instead only if
its unified OTel UX wins enough to justify at least $49/month or a separately approved
self-hosting burden.

End remote operational telemetry entirely—not just change vendor—if it yields no
diagnosis beyond the local surface. End full Agent content capture if it yields no
unique improvements, even if metadata/product analytics stay valuable.

## Alignment with adjacent decisions

### Research the Episode event journal and observability storage

This report preserves the separation settled by [Research the Episode event journal
and observability storage](https://github.com/rajat2006/coloop/issues/28):

- SQLite current-state/inbox/continuation/outbox records are authoritative.
- The narrow domain transition audit is not a product event or replay source.
- Telemetry is emitted after commit and is disposable.
- Telemetry IDs are safe correlation aliases, not provider/domain IDs.
- No event stream, telemetry outbox, or observability-backed projection is added.

### Define bridge restart and Discord reconciliation

[Define bridge restart and Discord reconciliation](https://github.com/rajat2006/coloop/issues/18)
still decides the exact durable cursor, replay window, ambiguous-delivery behavior,
and orphaned-turn policy. This report gives that decision named signals—reconnect
mode/result, replay/duplicate buckets, reconciliation duration/status, pending action
age—and forbids using those signals as the cursor or deduplication state.

### Define episode record retention audit and deletion

[Define episode record retention audit and deletion](https://github.com/rajat2006/coloop/issues/20)
still owns final local windows, compaction, deletion audit, and who may export a
support bundle. This report proposes a 7-day/50 MiB sanitized log ring, a 24-hour
support slice, deadline-lag signals, and vendor trial teardown. Those can be shortened
without changing Episode recovery.

### Define v0 observability and operational ownership

[Define v0 observability and operational ownership](https://github.com/rajat2006/coloop/issues/22)
should assign each local status/alert to the Owner or maintainer and define the exact
startup/readiness/support workflow. This report supplies the signal names,
thresholds, dashboard split, diagnostic contract, and limitation that remote absence
cannot page an Owner-local process.

Operational failure does not create a new Episode Phase. A disconnected Gateway,
provider quota block, pending delivery, failed cleanup, or dead exporter is runtime
status attached to the responsible component while the last acknowledged Episode
Phase remains unchanged.

## Final recommendation

1. **Instrument product milestones explicitly.** Use the nine-event inventory above,
   pseudonymous installation/Episode/operation IDs, server-side capture, and no Owner
   profile/autocapture.
2. **Instrument operations independently of Agent tracing.** Gateway,
   reconciliation, provider, delivery, SQLite, cleanup, quota, startup, and exporter
   signals are not derivable from a model run.
3. **Read Agent measurements from the settled full-trace stream once.** Use PostHog
   AI's run/turn/generation/tool, token, latency, error, and approximate-cost views;
   do not duplicate or remap them into application metrics or product events. Add a
   versioned OTel GenAI projection only if a later portability decision requires it.
4. **Use PostHog Cloud as the one remote backend for the bounded v0 trial.** It is
   likely $0 at measured Owner-local volume and has the best chance of demonstrating
   joined product + Agent value with minimal operations.
5. **Treat PostHog's beta tracing, alpha metrics, and five-minute log alerts as
   replaceable views.** Stable local JSON diagnostics and app-owned OTel schemas are
   the safety layer. Use Grafana Cloud as the measured split fallback, not an upfront
   dependency.
6. **Keep every observability path lossy and outside recovery.** No telemetry outbox,
   replay, vendor-generated recovery decision, raw ID, content copy, or phase change
   on observability failure.
7. **Bound privacy, cost, and time.** Dedicated project, named access, full-trace
   trial consent, 30 Episodes/300 turns/30 days, project teardown, hard $10/month cap,
   and explicit keep/split/stop gates.

## Remaining uncertainty

- PostHog's public pricing page currently omits general trace/application-metric
  metering and their separate retention. Verify both in the actual project before a
  card is attached or an ongoing promise is made.
- PostHog application metrics is alpha and distributed tracing beta; endpoints,
  query behavior, and schemas may change. The Collector and versioned adapter are the
  exit mechanism.
- OTel JavaScript logs and GenAI semantic conventions are still developing. The
  canonical Coloop application log/product schema must remain independent of
  library-specific types. If a portable Agent projection is later approved, its
  mapping needs separate contract tests.
- PostHog documents project/person deletion behavior but not one exact completion SLA
  across Product Analytics, Logs, Metrics, Distributed Tracing, and AI Observability.
  The disposable-project deletion exercise is required evidence.
- Provider-reported token usage and PostHog cost calculation do not establish
  account-level spend or remaining quota. Compare to provider billing/quota data when
  available and label estimates honestly.
- [Define bridge restart and Discord reconciliation](https://github.com/rajat2006/coloop/issues/18),
  [Define episode record retention audit and deletion](https://github.com/rajat2006/coloop/issues/20),
  and [Define v0 observability and operational ownership](https://github.com/rajat2006/coloop/issues/22)
  may refine reconciliation windows, local retention, alert thresholds, and
  ownership. They should reuse this signal contract rather than put recovery state
  or content into telemetry.
