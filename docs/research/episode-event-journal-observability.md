# Episode persistence and observability storage

Research date: 2026-08-29

## Question

Does Coloop v0 need a durable, append-only Collaboration Episode event journal,
or are transactional current-state and audit tables sufficient? Which data belongs
in recovery persistence, provider checkpoints, operational logs, metrics,
distributed traces, product analytics, and LLM/agent traces? Should Coloop use
PostHog, Langfuse, LangSmith, Phoenix, or a general OpenTelemetry backend?

## Direct answer

Coloop v0 should **not use event sourcing and should not introduce a dedicated
event-stream service**. Its recovery contract is small and current-state oriented:
the current Episode Phase, input deduplication state, provider continuation,
temporary interrupted `RunState`, pending outbound delivery, and an Episode Outcome
until it is acknowledged. Store those facts transactionally in Owner-local SQLite.
Add a narrow, append-only **domain audit** table for meaningful phase/control
transitions, but do not make that table authoritative or promise that the Episode
can be rebuilt by replaying it.

That distinction matters. Event sourcing makes an immutable sequence the source of
truth and derives current state through replay and projections. It is an optional
architecture with substantial concurrency, ordering, versioning, deletion, replay,
and operational costs—not an industry requirement. Microsoft's current architecture
guidance says traditional state management is sufficient for most systems and that
event sourcing is usually a poor fit for prototypes and MVPs. It can be added
selectively if Coloop later has a demonstrated need for historical reconstruction or
multiple independent projections. [Microsoft, Event Sourcing
pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)

For observability, use **OpenTelemetry as Coloop's emission contract** and keep the
vendor out of the recovery path. The recommended first trial is **PostHog Cloud**,
honoring the Owner's preference, behind a small Coloop telemetry adapter and an
OpenTelemetry Collector. PostHog currently combines OTel-native logs, AI trace UX,
evaluations, product analytics, and inexpensive free allowances. Its general
distributed tracing is still beta and application metrics are alpha, so it should
not become a hard dependency. PostHog's open-source self-host is explicitly a
hobbyist, single-machine deployment with limited support and missing Cloud features;
do not operate it for v0. [PostHog distributed
tracing](https://posthog.com/docs/distributed-tracing), [application
metrics](https://posthog.com/docs/metrics), [self-host
disclaimer](https://github.com/PostHog/posthog.com/blob/master/contents/docs/self-host/open-source/disclaimer.mdx)

The content policy is:

- Real Episodes emit metadata only by default.
- Real Discord turns and completed Agent replies may be added only after an explicit
  **Owner opt-in per installation**, with a visible participant disclosure, a
  dedicated restricted-access project, a kill switch, and the vendor's documented
  short content-retention window. Synthetic data is useful for pipeline tests but is
  not evidence that content inspection or evaluations improve real Episodes.
- Even in the opt-in mode, the Context Package, credentials, provider continuation
  IDs, Discord/provider IDs, serialized interrupted `RunState`, Episode Outcome,
  tool arguments/results, and raw exception bodies remain forbidden. Coloop should
  export only a curated completed collaborator-message/Agent-reply pair, never turn
  on an automatic full-generation capture path.

The leading specialist benchmark and fallback is **Langfuse**. It offers a free
Cloud Hobby plan, a free MIT-licensed self-hosted core, strong agent tracing and
evaluations, and OTel ingest. "Free self-hosted" does not mean zero cost: current
Langfuse uses a ClickHouse deployment model and Coloop would own upgrades, storage,
backups, availability, and access control. Its Cloud Hobby plan is the fair low-ops
comparison. [Langfuse Cloud pricing](https://langfuse.com/pricing), [self-hosted
pricing](https://langfuse.com/pricing-self-host)

This decision does **not** change the v0 topology: SQLite remains the authoritative
Owner-local recovery store; PostHog is optional, lossy egress. A later move to hosted
execution replaces SQLite with hosted Postgres using the same logical tables. It does
not require Kafka, Redpanda, NATS JetStream, or an event database.

## Evidence and inference convention

Product capabilities, protocol behavior, prices, limits, and documented defaults in
this report are **source-backed facts** and link to primary documentation or source
repositories. The proposed Coloop schema, privacy classification, retention defaults,
trial gates, and vendor choice are **architectural inferences/recommendations** from
those facts and the ticket-27 runtime evidence. Issues #18, #20, and #22 still own the
final reconciliation, retention, and operational-ownership policies.

The local ticket-27 probe is project evidence rather than an external source. It found
that SQLite currently contains Episode Phase; Discord routing and event IDs; content
SHA-256 values and mutable `pending` to `completed` processing status; the latest
Responses `previous_response_id`; Context Package path and deadline; Outcome until
acknowledgement; delivery/error state; and, only during an interruption, about 1007
bytes of serialized `RunState` containing the accepted in-flight collaborator text.
It found no completed transcript or Context Package body in SQLite, and the temporary
`RunState` was cleared after resume.

## Event journal, audit, inbox, and outbox are different things

| Mechanism | Source of truth? | Mutable? | Purpose in Coloop v0 |
| --- | --- | --- | --- |
| Event-sourced domain journal | Yes; current state is replayed from it | No; corrections are new events | **Do not add.** There is no demonstrated replay/projection requirement. |
| Current Episode row | Yes | Yes, under optimistic phase version | Authoritative lifecycle and recovery state. |
| Domain transition audit | No | Append-only except policy deletion/compaction | Human/operator explanation of important phase and control transitions. |
| Provider inbox/idempotency row | No, but recovery-critical | Yes: received/processing/completed/retryable | Suppress duplicate Discord deliveries and resume safely. The prototype's mutable event rows belong here. |
| Recovery action outbox | No, but recovery-critical until acknowledgement | Yes: pending/sent/failed | Bridge the database/external-side-effect atomicity gap for Discord posts and Outcome return. |
| OTel logs/traces/metrics | No | Backend-specific | Best-effort diagnosis and aggregate health; never replayed to recover an Episode. |
| Product analytics event | No | Usually immutable after ingestion | Intentional adoption and product-outcome analysis, not debugging or recovery. |

Event sourcing means that the append-only events are the authoritative record and
materialized views are derived by replay. Its benefits are real where immutable
history, point-in-time reconstruction, or many projections justify them, but its
costs include eventual consistency, optimistic-concurrency handling, idempotent
consumers, event ordering, schema upcasting, snapshots, and a conflict between
immutability and personal-data deletion. Microsoft's guidance also warns not to
confuse an event store with a broker such as Kafka. [Microsoft, Event Sourcing
pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)

Coloop v0 instead has one small state machine and one recovery reader. Startup needs
the latest phase/checkpoint/action status, not every historical intermediate state.
An immutable journal would duplicate current state, make deletion of conversational
data harder, and create a replay contract before any consumer needs it. The narrow
audit table preserves the useful part—"why did this Episode transition?"—without
claiming every implementation detail is a permanent domain event.

Reconsider event sourcing only when at least one concrete requirement exists:

1. Current state must be reconstructible solely from an immutable domain history.
2. Point-in-time Episode reconstruction is a product or compliance requirement.
3. Several independently deployed consumers need every domain transition, and new
   projections must be built from historical data.
4. A business invariant genuinely benefits from per-aggregate event-stream
   concurrency rather than ordinary transactional rows.

Until then, an audit table plus normal backups is simpler and safer. A purpose-built
event database is not needed merely because the product processes Discord "events."

## Exact storage and signal boundaries

| Class | Examples | Durability and failure semantics | Export policy |
| --- | --- | --- | --- |
| Recovery-critical domain persistence | Episode ID, Owner Pairing, Phase and phase version, terminal status, finalization authority, Context Package reference/deadline, Outcome until acknowledged | Transactional SQLite; a committed transition must survive a process restart | Never exported as bodies. Only allowlisted phase/status metadata may be copied into telemetry. |
| Provider continuation/checkpoint | OpenAI `previous_response_id`; SDK/version; temporary serialized interrupted `RunState`; accepted input association | Local restricted state. Continuation persists while needed; `RunState` exists only while an accepted run is interrupted and is deleted after resolution | Never export IDs or serialized state. Export only booleans/counts such as `resume_attempted=true`, byte size, result enum. |
| Provider inbox and recovery outbox | Discord external event ID, content digest, input status; exact pending outbound payload/ref, destination, attempts, acknowledgement | Transactional and retryable. Required for duplicate suppression and external side-effect recovery | Never export raw IDs, content digest, payload, destination, or error message. Export attempt number and allowlisted result/error class. |
| Operational logs | Process start/stop, phase transition result, retry, queue depth, exporter failure | Best effort; useful if present, never authoritative | Structured, metadata-only. No raw request/response bodies, paths, stack values, headers, IDs, hashes, or free-form exception messages. |
| Metrics | Episode starts/finalizations/failures, phase duration, model latency, token/cost totals, dropped telemetry, pending actions | Aggregated, lossy, and non-identifying. A missing sample cannot alter behavior | OTel counters/histograms with low-cardinality labels; no Episode, Owner, collaborator, or thread identifiers. |
| Distributed traces | Discord receive → idempotency check → model run → queued reply → provider acknowledgement | Diagnostic causal timing. OTLP may retry and duplicate; backends may drop | Random trace/span IDs plus metadata-only attributes. Not a state-recovery record. |
| Product analytics | Installation activated, Episode opened/finalized/cancelled, opt-in conversion, feature outcome | Intentional product behavior events. Separate purpose and schema from operational telemetry | Pseudonymous installation/telemetry Episode IDs only; no conversation bodies unless the separate content opt-in explicitly applies. |
| LLM/agent traces | Agent turn/generation/tool topology, model, latency, token use, evaluation score | Diagnostic/evaluation data. Backend loss must not affect the Agent run | Metadata-only by default. Opt-in may add curated completed Discord input and Agent reply; all other sensitive classes stay excluded. |

OpenTelemetry itself treats model instructions, user messages, and model outputs as
sensitive and often large; its GenAI conventions say instrumentation should not
capture them by default and should require opt-in. [OpenTelemetry GenAI span
conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)

## Proposed v0 recovery schema

The following is logical DDL, not a commitment to a particular TypeScript SQL
library. Use application-generated UUIDs, explicit constraints, and UTC timestamps so
the identifiers and semantics transfer to Postgres. SQLite may store timestamps and
JSON as canonical text; Postgres can use `timestamptz`, `jsonb`, and `bytea`.

```sql
CREATE TABLE episode (
  id                         TEXT PRIMARY KEY,
  telemetry_episode_id       TEXT NOT NULL UNIQUE,
  owner_pairing_id           TEXT NOT NULL,
  owner_discord_id            TEXT NOT NULL,
  discord_thread_id           TEXT UNIQUE,
  phase                       TEXT NOT NULL,
  phase_version               INTEGER NOT NULL DEFAULT 0,
  context_package_ref         TEXT NOT NULL,
  context_package_sha256      BLOB NOT NULL,
  context_retention_due_at    TEXT,
  outcome_json                TEXT,
  outcome_acknowledged_at     TEXT,
  terminal_at                 TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  CHECK (phase IN ('CREATED', 'ACTIVE', 'FINALIZED', 'CANCELLED'))
);

CREATE TABLE agent_continuation (
  episode_id                  TEXT PRIMARY KEY REFERENCES episode(id),
  provider                    TEXT NOT NULL,
  continuation_id_ciphertext  BLOB,
  sdk_name                    TEXT NOT NULL,
  sdk_version                 TEXT NOT NULL,
  interrupted_run_state       BLOB,
  interrupted_external_id     TEXT,
  run_state_format_version    INTEGER,
  interrupted_at              TEXT,
  recover_until               TEXT,
  updated_at                  TEXT NOT NULL
);

CREATE TABLE provider_inbox (
  provider                    TEXT NOT NULL,
  external_event_id           TEXT NOT NULL,
  episode_id                  TEXT NOT NULL REFERENCES episode(id),
  payload_sha256              BLOB NOT NULL,
  status                      TEXT NOT NULL,
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  last_error_class            TEXT,
  received_at                 TEXT NOT NULL,
  completed_at                TEXT,
  updated_at                  TEXT NOT NULL,
  PRIMARY KEY (provider, external_event_id),
  CHECK (status IN ('RECEIVED', 'PROCESSING', 'RETRYABLE',
                    'COMPLETED', 'QUARANTINED'))
);

CREATE TABLE episode_transition_audit (
  audit_id                    TEXT PRIMARY KEY,
  episode_id                  TEXT NOT NULL REFERENCES episode(id),
  episode_version             INTEGER NOT NULL,
  transition_type             TEXT NOT NULL,
  actor_kind                  TEXT NOT NULL,
  cause_kind                  TEXT NOT NULL,
  cause_ref_digest            BLOB,
  metadata_json               TEXT NOT NULL DEFAULT '{}',
  schema_version              INTEGER NOT NULL,
  occurred_at                 TEXT NOT NULL,
  UNIQUE (episode_id, episode_version)
);

CREATE TABLE recovery_action_outbox (
  action_id                   TEXT PRIMARY KEY,
  episode_id                  TEXT NOT NULL REFERENCES episode(id),
  episode_sequence            INTEGER NOT NULL,
  action_kind                 TEXT NOT NULL,
  idempotency_key             TEXT NOT NULL UNIQUE,
  destination_ref             TEXT NOT NULL,
  sensitive_payload           BLOB,
  payload_ref                 TEXT,
  status                      TEXT NOT NULL,
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at             TEXT,
  last_error_class            TEXT,
  created_at                  TEXT NOT NULL,
  acknowledged_at             TEXT,
  UNIQUE (episode_id, episode_sequence),
  CHECK (status IN ('PENDING', 'SENDING', 'ACKNOWLEDGED',
                    'RETRYABLE', 'QUARANTINED'))
);
```

The exact private-field encryption mechanism is an implementation decision, but the
schema makes the boundary visible. `continuation_id_ciphertext`, temporary
`interrupted_run_state`, exact pending payloads, raw Discord IDs, Context Package
reference/digest, and Outcome are restricted local data. `telemetry_episode_id` is a
random, vendor-facing pseudonym that is not a Discord snowflake, database primary
key, content hash, or provider continuation ID.

`episode.phase` is only the Owner-visible **Episode Phase**. Provider failure,
exporter health, retry state, and worker status belong in the inbox, continuation,
outbox, and telemetry records; they must not introduce an infrastructure `FAILED`
business phase. The final phase names remain a domain-state-machine decision, but the
separation is required by the current vocabulary.

The audit table contains only lifecycle/control metadata, not message bodies,
Context Package data, Outcome text, provider payloads, or a serialized whole-row
snapshot. It is deliberately insufficient to rebuild an Episode. That is a feature:
it avoids accidentally creating an undeletable transcript-shaped event store.

## Atomicity, ordering, idempotency, and replay

### One transaction per durable state change

For an accepted transition, one SQLite transaction should:

1. Validate the expected `episode.phase` and `phase_version`.
2. Update the current Episode row with
   `WHERE id = ? AND phase_version = ?`, incrementing the version.
3. Append the corresponding metadata-only audit row with
   `UNIQUE (episode_id, episode_version)`.
4. Update the provider inbox and continuation/checkpoint rows as applicable.
5. Insert any required external action into `recovery_action_outbox`.

Zero rows updated means a stale writer and must be retried from fresh state. SQLite
supports atomic transactions, multiple readers, and one simultaneous writer. WAL
mode permits concurrent readers and a writer, but remains a same-host design with a
single writer; the `-wal` file is part of persistent database state and must stay
with a moved/copied database. [SQLite transaction
semantics](https://www.sqlite.org/lang_transaction.html), [SQLite
WAL](https://www.sqlite.org/wal.html)

An OpenAI call or Discord HTTP request cannot share that database transaction. The
recovery action outbox exists for **product side effects**, not for telemetry: commit
the intended exact outbound action with the state change, then dispatch and mark it
acknowledged. A crash after an ambiguous provider response can still produce a retry;
provider-specific reconciliation and deduplication remain for issue #20. The
transactional-outbox pattern prevents a database/message dual write from silently
diverging, but consumers and providers still need idempotency because duplicate
delivery is possible. [AWS, Transactional Outbox
pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

### Ordering rules

- `episode.phase_version` is the causal order for lifecycle transitions within one
  Episode.
- `recovery_action_outbox.episode_sequence` is the intended outbound order within one
  Episode; a dispatcher must not overtake an earlier unacknowledged action unless a
  later policy explicitly permits it.
- The provider's external event ID is the inbox deduplication key. The content digest
  detects the exceptional case where the same external ID arrives with different
  bytes; that case is quarantined rather than treated as a new turn.
- Wall-clock timestamps are diagnostic and retention inputs, not a global causal
  order. There is no meaningful total order across independent Episodes.
- OTel parent/span relationships explain an observed execution. They do not replace
  `phase_version` or establish database commit order.

### Mutable inbox rows are not events

The ticket-27 prototype's `pending` to `completed` Discord rows correctly model a
provider **inbox processing state machine**. They answer "has this external delivery
been durably accepted and finished?" An append-only domain event would instead state
a business fact such as `EpisodeFinalizationRequested`. Renaming and separating the
table prevents future code from treating provider bookkeeping as permanent business
history.

### Projections and replay

There are no v0 event projections. Read the current `episode`, continuation, inbox,
and action rows directly. Startup recovery does not replay the audit table; it finds
nonterminal Episodes, recoverable interrupted runs, `RECEIVED`/`RETRYABLE` inputs,
and unacknowledged actions. Audit compaction or deletion must not change recovery.

If Coloop later emits product-analytics events or builds dashboards from transition
audits, those are disposable derived views. A dashboard must be rebuildable from
current data or tolerate gaps; it must never become an unacknowledged recovery
dependency.

### Schema evolution

- Maintain normal numbered database migrations and record the application schema
  version.
- Prefer additive columns and tolerant JSON readers. Give audit metadata an explicit
  `schema_version`, but do not promise indefinite upcasters because audit is not a
  replay source.
- Generate IDs in the application and do not expose SQLite `rowid` as a public or
  correlation contract.
- Version serialized Agents SDK `RunState` separately with SDK name/version. If an
  old snapshot cannot be read, quarantine it and use the reconciliation policy; do
  not guess.
- If event sourcing is adopted for a proven subsystem later, start a new explicit
  event-stream contract then. Do not retroactively declare old audit rows complete
  domain history.

## Local/offline and failure behavior

SQLite recovery continues while PostHog, the Collector, or the internet is down.
Work requiring Discord or OpenAI pauses in the inbox/outbox/checkpoint state and
retries according to the provider policy. Observability failure only increments a
local dropped/export-failure counter and may produce a metadata-safe local stderr
record; it never rolls back an Episode transition or blocks an Agent reply.

OTLP defines stable trace, metric, and log signals, but its delivery semantics are
appropriate for telemetry rather than domain state. A client may resend after an
ambiguous acknowledgement and create duplicates. Collector sending queues drop new
data when full and drop old data after the retry deadline; a file-backed queue can
survive a Collector restart, but data can still be lost on disk exhaustion, disk
failure, or prolonged backend outage. [OTLP
specification](https://opentelemetry.io/docs/specs/otlp/), [Collector
resiliency](https://opentelemetry.io/docs/collector/resiliency/)

Use an in-memory Collector queue for v0 unless telemetry loss is shown to be costly.
A file-backed Collector queue can be added later, but it must be stored separately
from Episode recovery data and must still contain only export-safe fields. Do not add
a transactional telemetry outbox to SQLite: that would quietly turn optional
telemetry into another durable product workload.

## Privacy classification, retention, deletion, and compaction

### Classification

| Classification | Data | Rule |
| --- | --- | --- |
| Restricted recovery content | Context Package and path, Opening Brief/pending exact outbound text, completed Outcome until acknowledgement, temporary `RunState`, provider continuation, raw Discord/thread/message IDs, credentials | Owner-local only; credentials belong in OS secret storage, not these tables. Encrypt or otherwise protect sensitive local blobs and minimize lifetime. |
| Restricted conversational content | Completed collaborator Discord text and completed Agent reply | Not locally mirrored after completion. Vendor export is off by default and allowed only by the explicit installation content opt-in and visible participant disclosure. |
| Export-safe pseudonymous metadata | Random telemetry Episode ID, phase/result enum, attempt count, model/release, token count, duration, content byte count, allowlisted error class | Positive allowlist only. No free-form strings, stable provider IDs, paths, content hashes, raw stack traces, or exception messages. |
| Aggregate metric | Counts/rates/histograms without installation/Episode/person cardinality | Exportable by default. |

A raw SHA-256 of message content is useful locally for Discord duplicate detection but
is **not anonymized telemetry**: it is a stable fingerprint and may be guessable for
short messages. Do not export it. Likewise, pseudonymous identifiers are still
linkable personal data; restrict access and delete them on the telemetry retention
schedule.

### Recommended interim local lifecycle

These are defaults for safe progress, not final product policy:

- Delete serialized `RunState` immediately after successful resume, finalization, or
  cancellation. While genuinely interrupted, retain it only through the Episode's
  recovery deadline plus a short reconciliation grace; issue #18 decides the final
  window.
- Retain exact outbound payload only until provider acknowledgement and any ambiguous
  delivery reconciliation window. Retain the Outcome only until the Origin Session
  acknowledges it.
- Keep the minimum provider inbox key/status needed to suppress replay for the
  reconciliation window. Compaction may remove error details and payload digest after
  closure while retaining a short-lived deduplication tombstone; issue #20 decides
  the exact window.
- Keep metadata-only audits for a provisional 30 days after terminal state, then
  compact/delete unless a product/compliance requirement justifies longer. Recovery
  must continue to work after they are gone.
- Credentials are never journaled. Local deletion from SQLite does not necessarily
  overwrite old pages or backups immediately; combine short lifetimes with encrypted
  storage/key deletion and a backup-retention policy rather than promising physical
  erasure from a simple `DELETE`.

### Real-content opt-in

The confirmed policy is an Owner-controlled installation setting, disabled by
default. A credible content-value trial needs a small sample of **real consenting
Episodes**; synthetic traces prove only instrumentation and UI plumbing.

The setting should have these controls:

1. An explicit confirmation naming the vendor, fields, purpose, region, access group,
   and documented retention. No bundled consent with basic telemetry.
2. A notice in every affected Discord Episode before capture begins so collaborators
   know completed messages and Agent replies may be copied for product improvement.
3. A narrow content allowlist: the completed collaborator message and corresponding
   completed Agent reply only. Exclude the Context Package, system instructions,
   credentials, prior managed history, Outcome, tool arguments/results, provider IDs,
   raw errors, and interrupted `RunState` even when content mode is on.
4. A dedicated trial project with the smallest membership, no broad product-analytics
   audience, appropriate US/EU region, and no batch export of content.
5. A local kill switch that immediately stops new content capture without waiting for
   the vendor. Disabling does not by itself delete already-ingested data; the UI must
   say so and link to a verified deletion/end-of-trial procedure.
6. Time-boxed review. PostHog documents 30-day retention for large AI input/output
   properties, not an arbitrary shorter self-serve TTL. If 30 days is too long, do not
   send real content until a verified shorter deletion control exists. Destroy the
   dedicated trial project at the end and verify the vendor's deletion behavior; the
   exact deletion SLA is an open due-diligence item.

Real content makes qualitative trace inspection, LLM-as-judge scoring, human review,
failure clustering, and prompt/reply comparisons materially more useful. Metadata
alone still answers latency, token, cost, error, retry, topology, and phase questions.
The acceptance test must measure whether content produced actionable improvements
that metadata could not; content capture is not justified merely because a vendor UI
can display it.

## Recommended instrumentation and export contract

```text
Episode runtime
  ├─ transactional recovery state ───────────────> SQLite
  └─ Coloop EpisodeTelemetry allowlist
       ├─ OTel logs/metrics/spans ───────────────> local OTel Collector
       │                                            ├─ PostHog trial exporter
       │                                            └─ optional benchmark/fan-out
       └─ opt-in curated content fields ─────────> PostHog AI endpoint

PostHog/Collector unavailable
  └─ drop/retry telemetry only; SQLite and Episode behavior are unchanged
```

Define a vendor-neutral internal interface such as:

```ts
interface EpisodeTelemetry {
  phaseTransition(metadata: SafePhaseTransition): void;
  providerAttempt(metadata: SafeProviderAttempt): void;
  agentTurn(metadata: SafeAgentTurn): SpanHandle;
  completedContent?(content: ConsentedCompletedTurn): void;
  counter(name: SafeMetricName, value: number, labels: SafeLabels): void;
}
```

The types should make unsafe strings unrepresentable where practical. The adapter
constructs standard OTel resource/span/log fields plus a small versioned `coloop.*`
namespace. It must reject unknown attributes and validate payloads in tests with
sentinel Context Package, Discord, credential, Outcome, and `RunState` strings.

Suggested span hierarchy:

```text
episode.turn                         one accepted completed Discord turn
  discord.receive                    metadata only
  episode.inbox.claim                new / duplicate / retry
  gen_ai.invoke_agent                model, latency, token usage; no provider IDs
  episode.reply.enqueue              metadata only
  discord.reply.acknowledge          result/error class
```

Use random trace/span IDs. A separate random `coloop.episode.telemetry_id` correlates
turns across an Episode without disclosing the database Episode ID. Keep product
analytics event names separate from operational logs even if PostHog stores both in
one project.

### OpenAI Agents SDK tracing seam

The TypeScript Agents SDK currently enables tracing by default in server runtimes
and traces runs, agent/turn spans, LLM generations, function calls, guardrails, and
handoffs. Its generation spans can store LLM inputs/outputs and function spans can
store function inputs/outputs. It provides `traceIncludeSensitiveData` and custom
trace processors; replacing the processors means traces are not sent to OpenAI unless
the OpenAI processor is explicitly re-added. [OpenAI Agents SDK tracing
guide](https://openai.github.io/openai-agents-js/guides/tracing/)

Installed-source evidence for the probed `@openai/agents` 0.17.0 says
`traceIncludeSensitiveData` defaults to true and exposes `tracingDisabled`,
`setTraceProcessors`, `addTraceProcessor`, and `setTracingDisabled`; the prototype
currently disables tracing. Coloop must never inherit those defaults accidentally.

Recommended configuration:

- Set sensitive SDK trace capture false explicitly.
- Replace/disable the default OpenAI exporter and route a reviewed metadata-only
  processor into `EpisodeTelemetry`; test that no duplicate default export remains.
- Do **not** set sensitive capture true for the PostHog content trial. Automatic SDK
  capture would include broader model and tool state than the consent allows. Emit
  the curated completed message/reply pair through the separate opt-in method.
- Flush asynchronously on graceful shutdown, but never delay a durable Episode
  transition waiting for an exporter.

## PostHog capability assessment as of the research date

### Logs

PostHog Logs is an OTel-native store: any OTLP client can send records, and the UI can
search by service, severity, and attribute, cluster patterns, correlate with other
PostHog data, alert, and query through an API. [PostHog Logs](https://posthog.com/docs/logs)

PII scrubbing is opt-in, ingestion-time, non-retroactive, and explicitly
best-effort. It examines log body/attributes for known patterns and sensitive key
names, but PostHog advises not sending PII and redacting at the client. That supports
Coloop's positive allowlist; scrubbing is defense in depth, not the boundary.
[PostHog log PII scrubbing](https://posthog.com/docs/logs/pii-scrubbing)

Logs include 10 GB/month free. Current paid tiers are $0.25/GB from 10–300 GB and
$0.15/GB above 300 GB. Default retention is 14 days; a $0.05/GB add-on extends newly
ingested logs to 30 days. PostHog itself recommends metadata rather than payloads.
[PostHog Logs pricing](https://posthog.com/docs/logs/pricing)

### OpenTelemetry, traces, and metrics

General distributed tracing accepts standard OTLP without a PostHog SDK, but is
currently **beta** and its setup may change. Application metrics accepts OTel and
Prometheus-shaped input but is **alpha**. Coloop may trial both, but should not depend
on either for recovery, SLO enforcement, or an irreplaceable query. [PostHog
distributed tracing](https://posthog.com/docs/distributed-tracing), [PostHog
metrics](https://posthog.com/docs/metrics)

PostHog's AI OTel endpoint is more specialized. It accepts OTLP/HTTP JSON or protobuf
traces, not gRPC; it is traces-only, filters for AI namespaces, and caps a request at
4 MB. The PostHog span processor translates GenAI attributes and preserves trace/span
identity, but PostHog recommends vendor-specific fields for some richer behavior.
[PostHog OTel AI installation](https://posthog.com/docs/ai-observability/installation/opentelemetry)

Official documentation establishes OTLP **ingest**, not generic OTLP egress. PostHog
batch exports can reliably send PostHog's immutable product-event model to S3,
Postgres, BigQuery, Snowflake, Redshift, Databricks, or Azure Blob, but that is a
vendor event schema rather than a round-trip OTLP trace/log export. Therefore fan out
at the Collector before ingestion and keep Coloop's schema in code. [PostHog batch
exports](https://github.com/PostHog/posthog.com/blob/master/contents/docs/cdp/batch-exports/index.mdx)

### AI/LLM observability and evaluations

AI Observability supplies trace/session/generation views, cost/latency/token analysis,
alerts, customer/product joins, feedback, prompt management, and evaluations. Native
wrappers are designed to capture conversations, requests, and responses, which is
valuable under consent but unsafe as Coloop's default. [PostHog AI Observability
start](https://posthog.com/docs/ai-observability/start-here)

PostHog privacy mode excludes `$ai_input` and `$ai_output_choices`. It is useful as an
additional switch but not a substitute for Coloop's allowlist because arbitrary
custom attributes, logs, tool values, and errors can still be sensitive. [PostHog AI
privacy mode](https://posthog.com/docs/ai-observability/privacy-mode)

Large AI properties—including inputs, outputs, input/output state, and tools—are held
in the AI events table for 30 days and then removed. A trimmed normal event remains
with model, provider, token, cost, latency, and trace metadata under ordinary product
retention. [PostHog AI retention](https://posthog.com/docs/ai-observability/data-retention)

### Pricing, Cloud, self-host, and operational risk

The current Cloud free allowances include 100,000 AI Observability events/month,
10 GB Logs/month, and one million product analytics events/month. The free account has
one project and one-year general data retention; usage stops at the free limit. Paid
usage allows more projects and seven-year general retention, with product-specific
retention exceptions such as Logs and large AI properties. [PostHog
pricing](https://posthog.com/pricing)

Cloud offers regional hosting and PostHog's trust portal publishes SOC 2 Type II and
other compliance material. Those controls do not decide whether Coloop should send
content; consent, purpose, access, and deletion still do. [PostHog Trust
Center](https://trust.posthog.com/)

The open-source self-host is MIT-licensed, but PostHog describes it as for hobbyists,
single-machine, limited-support, unable to guarantee recovery from data loss, and
missing Cloud features. It also requires Coloop to operate an analytics platform.
PostHog Cloud is the lower-risk v0 trial despite the availability of source code.
[PostHog self-host
disclaimer](https://github.com/PostHog/posthog.com/blob/master/contents/docs/self-host/open-source/disclaimer.mdx)

### PostHog failure contract for Coloop

This is an architectural inference from the protocols and maturity above:

- SDK/Collector initialization failure logs one metadata-safe warning and disables
  export; Episode startup continues.
- Export happens after the application commits. Backpressure never enters the Episode
  transaction.
- Retry only bounded transient OTLP failures. Count queue overflow, permanent 4xx,
  partial rejection, and 4 MB rejection locally.
- Do not attempt to reconstruct missing telemetry, and tolerate backend duplicates.
- A PostHog outage affects only dashboards/evaluations. It cannot lose Phase,
  continuation, pending delivery, or Outcome.
- The trial must include network-cut, invalid-token, quota-stop, oversized-batch, and
  shutdown tests.

## Alternatives for an observability agent tracer

| Platform | Standards and portability | Agent trace/eval UX | Privacy/deployment | Burden and lock-in | Coloop verdict |
| --- | --- | --- | --- | --- | --- |
| **PostHog Cloud** | OTel-native logs; OTLP general traces (beta), metrics (alpha), and AI trace ingest. Batch egress is PostHog event schema, not OTLP. | Good combined traces, generations, costs, feedback/evals, and product analytics; less specialist depth than Langfuse/LangSmith. | US/EU Cloud, ingestion scrubbing, privacy mode; real content opt-in only. Hobby self-host is not recommended for v0. | Low Cloud operations; moderate schema lock-in for AI/product queries. | **First bounded trial**, because the Owner prefers it and the combined product is useful. Keep adapter/Collector exit. |
| **Langfuse Cloud / OSS** | OTLP/HTTP ingest; aims at OTel GenAI but maps evolving conventions into its model and recommends `langfuse.*` attributes for best UX. No gRPC today. | Excellent dedicated agent graphs/sessions, datasets, experiments, LLM judges, human annotation, prompts, feedback. | Client-side masking; US/EU/JP Cloud. Cloud Hobby is free with 50k units and 30-day access. MIT core self-host is free. | Cloud is low-ops. Self-host owns a ClickHouse-based stack, backups, upgrades, and access. Vendor attributes improve UX and increase lock-in. | **Leading specialist benchmark/fallback.** Compare the same consented sample if PostHog UX/evals are insufficient. |
| **LangSmith** | OTel ingest/fan-out and broad GenAI/OpenInference mapping, but strong LangSmith fields and run model. | Probably the strongest polished thread/trajectory, offline/online eval, dataset, and experiment experience. | Input/output hiding and anonymizers. Self-host is an Enterprise add-on, with a recommended Kubernetes footprint of at least 16 vCPU/64 GB. | SaaS free plan is 5k base traces; Plus is $39/seat. Proprietary product and highest self-host burden/lock-in here. | Strong capability reference; reject for v0 unless its eval workflow clearly beats cheaper choices. |
| **Arize Phoenix** | OTel/OpenInference ingest over HTTP or gRPC; open source under Elastic License 2.0, not a permissive MIT/Apache license. | Strong traces, datasets, experiments, LLM/code evals, playground, and replay. | Lightweight single container; default SQLite for local/single-user and Postgres for production. Self-host data stays local; telemetry can be disabled/air-gapped. | Lowest specialist local-ops entry, but Coloop still owns storage/backup/auth; advanced scale/production evaluation paths may lead to Arize AX. | Best privacy-first local specialist and useful fallback if Cloud content is unacceptable. |
| **Grafana Cloud / OSS stack** | First-class OTel/Prometheus; open PromQL/LogQL/TraceQL; managed Cloud or self-host Prometheus/Loki/Tempo/Grafana. | Excellent general logs/metrics/traces/correlation; weaker first-class datasets, human annotation, and agent evaluation workflow. | Mature managed or self-host options; content governance remains ours. | Low lock-in at telemetry/query layer; self-hosting multiple storage systems is high operations. | Best when operational observability is the primary need, not the first agent-quality workbench. |
| **Honeycomb** | Strong OTLP ingest and general distributed tracing. | Excellent high-cardinality exploration and causal operational traces; limited dedicated agent eval/dataset workflow. | Managed SaaS; no comparable local specialist path. | Low app instrumentation lock-in through OTel, but SaaS/query workflow dependency. | Good general tracing benchmark, not the selected agent-eval tool. |
| **SigNoz Cloud / OSS** | OTel-native logs/metrics/traces and explicit GenAI conventions; prompt/response capture is off by default. | Good GenAI latency/token/cost and trace exploration; less mature dedicated dataset/evaluation lifecycle. | Cloud or self-host; content opt-in matches OTel's privacy default. | Lower data-model lock-in, but self-hosting an observability stack is operational work. | Credible OTel-native general alternative if PostHog's beta/alpha signals are limiting. |

Sources for the comparison:

- Langfuse receives OTLP/HTTP, documents the evolving GenAI mapping and vendor
  attributes, and supports Collector filtering. [Langfuse OpenTelemetry
  integration](https://langfuse.com/integrations/native/opentelemetry)
- Langfuse Cloud Hobby is free with 50,000 units/month, two users, and 30 days of
  access; its self-hosted core is free/MIT and includes agent traces, evaluations,
  prompts, datasets, and APIs. [Langfuse Cloud pricing](https://langfuse.com/pricing),
  [Langfuse self-host pricing](https://langfuse.com/pricing-self-host)
- Langfuse supports client-side masking before transmission; self-host defaults to
  indefinite retention unless configured, while Cloud access windows depend on plan.
  [Langfuse masking](https://langfuse.com/self-hosting/security/data-masking),
  [retention](https://langfuse.com/docs/administration/data-retention)
- LangSmith supports standard OTel applications and Collector fan-out, can hide or
  transform inputs/outputs, and supports offline/online and agent-trajectory
  evaluations. [LangSmith OTel](https://docs.langchain.com/langsmith/trace-with-opentelemetry),
  [sensitive data](https://docs.langchain.com/langsmith/mask-inputs-outputs),
  [evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts)
- LangSmith self-host is an Enterprise add-on and its Kubernetes guide recommends at
  least 16 vCPU and 64 GB. Base traces retain 14 days and extended traces 400 days;
  some eval/automation actions upgrade retention and cost. [LangSmith
  self-host](https://docs.langchain.com/langsmith/self-hosted), [Kubernetes
  requirements](https://docs.langchain.com/langsmith/kubernetes), [retention
  tiers](https://docs.langchain.com/langsmith/administration-overview), [LangSmith
  pricing](https://www.langchain.com/pricing)
- Phoenix is an OTel-based AI observability/evaluation platform. Its single app
  contains a UI, trace collector, and SQL backend; SQLite is the default and Postgres
  is recommended for production. Self-hosted trace/eval/dataset content remains in
  the deployment and default trace retention is indefinite but configurable.
  [Phoenix repository](https://github.com/Arize-ai/phoenix), [architecture](https://arize.com/docs/phoenix/self-hosting/architecture),
  [privacy](https://arize.com/docs/phoenix/self-hosting/security/privacy), [retention](https://arize.com/docs/phoenix/settings/data-retention)
- Grafana Cloud is the managed version of its open-source Prometheus/Loki/Tempo stack,
  with OTel as a first-class standard and managed logs, traces, metrics, and profiles.
  [Grafana Cloud overview](https://grafana.com/docs/grafana-cloud/learn-and-build/get-started/learn/)
- Honeycomb accepts OTel data and prices its managed service by event volume.
  [Honeycomb data ingest](https://docs.honeycomb.io/send-data), [Honeycomb
  pricing](https://www.honeycomb.io/pricing)
- SigNoz's current LLM observability uses standard OTel GenAI signals and explicitly
  keeps prompt/completion content off by default. [SigNoz LLM
  observability](https://signoz.io/docs/llm-observability/)

PostHog and Langfuse both have usable free Cloud tiers. Langfuse additionally has a
free self-hosted core, but the meaningful comparison is total cost: vendor invoice,
engineering operations, data-control needs, access/governance, product fit, and exit
cost. Initial dollar price alone should not select the tracer.

## Rejected event-storage alternatives

| Candidate | What it provides | Why not v0 |
| --- | --- | --- |
| Append-only table in SQLite/Postgres | Familiar SQL, transaction with current state/outbox, audit ordering constraints | Use only for the narrow transition audit. Making it authoritative would still create all event-sourcing replay/versioning obligations. |
| EventStoreDB/KurrentDB | Purpose-built event streams, projections, persistent subscriptions, checkpoints, at-least-once delivery | Adds a server and a new source-of-truth model for needs Coloop does not have. Kurrent's docs also warn subscriptions can redeliver/out-of-order and server projections add write amplification. |
| Kafka/Redpanda | Durable partitioned transaction log, replay, fan-out, retention/compaction; Redpanda speaks Kafka API | A broker/distribution log is not a per-Episode event store or transactional current-state database. It solves scale and multi-consumer problems absent from local v0. |
| NATS JetStream | Persistent/replayable messages, consumers, retention, at-least-once delivery, dedupe/double-ack tools | Still an external broker with acknowledgement, retention, and deduplication operations. SQLite inbox/outbox is smaller and atomically co-located with Episode state. |

Kurrent persistent subscriptions are at least once and can replay after checkpoints;
ordering is not guaranteed for competing consumers. Its server projections can add
substantial write amplification. [Kurrent persistent
subscriptions](https://docs.kurrent.io/server/v25.1/features/persistent-subscriptions),
[projections](https://docs.kurrent.io/server/v23.10/features/projections/)

Redpanda describes itself as a fault-tolerant transaction log for event streams; its
topics have delete/compaction and time/size retention policies. [Redpanda
architecture](https://docs.redpanda.com/cloud-data-platform/get-started/architecture/),
[topic configuration](https://docs.redpanda.com/streaming/current/develop/manage-topics/config-topics/)

JetStream persists and replays messages, uses at-least-once delivery by default, and
offers publisher deduplication plus double acknowledgement for an exactly-once
quality of service within configured mechanisms. Those are useful broker semantics,
not a reason to add a broker. [NATS JetStream
concepts](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/README.md)

## Migration from Owner-local SQLite to hosted Postgres

The logical schema deliberately migrates without changing the persistence model:

1. Ship numbered migrations and application-generated IDs from day one. Avoid public
   dependence on `rowid`, SQLite timestamp sorting quirks, or SQLite-only JSON logic.
2. At cutover, stop the local writer and outbound dispatcher. Checkpoint/close WAL,
   take a backup that includes all persistent state, and record row counts and hashes
   per table.
3. Transform SQLite canonical text/BLOB columns to Postgres `timestamptz`, `jsonb`,
   and `bytea`; recreate primary, unique, check, and foreign-key constraints.
4. Validate counts, nonterminal Episode state, inbox/outbox status, continuation
   decryptability, phase versions, uniqueness, foreign keys, and a sample of content
   digests before changing the endpoint.
5. Start hosted workers against Postgres, reconcile Discord/OpenAI state, then resume
   dispatch. Keep the local database read-only through a rollback window; do not run
   two writers.
6. In hosted concurrency, retain optimistic `phase_version` and use transactional row
   leasing/`FOR UPDATE SKIP LOCKED` for inbox/outbox workers. Add tenant/Owner scope to
   every key and query before more than one Owner shares infrastructure.

Hosted Postgres moves restricted recovery data out of the Owner's machine, which is a
new trust and operational-ownership decision for issue #22. It does not follow from
selecting PostHog, and PostHog must never substitute for the Postgres backup/recovery
plan.

## Trial plan and decision gates

Proceed with a bounded PostHog Cloud trial, then make a product decision rather than
an instrumentation decision.

### Stage 1: metadata and failure contract

Use synthetic and local deterministic Episodes to validate:

- the OTel/adapter mapping and PostHog trace tree;
- correlation from Episode turn to safe log without raw IDs;
- phase/model/token/latency/error dashboards;
- duplicate OTLP tolerance and Collector fan-out;
- no effect on recovery during network, authentication, quota, and backend failure;
- automated negative tests proving Context Package, credentials, Discord/provider
  IDs, hashes, Outcome, `RunState`, tool values, and raw errors never leave the
  process.

### Stage 2: consented real-content value

Enable the explicit installation opt-in for a small, time-boxed set of real Episodes
with participant disclosure. Export only completed collaborator message and Agent
reply content. Review access and end the trial within the 30-day PostHog content
window.

Compare PostHog against Langfuse Cloud Hobby on the same kind of consented sample if
PostHog's agent UX is unclear. This is a benchmark, not a mandate to operate Langfuse.

### Acceptance evidence

Keep PostHog if the trial demonstrates all of the following:

1. An operator can diagnose latency/retry/model failures from metadata alone without
   consulting recovery tables.
2. Consented content inspection or evaluations produce concrete Episode/Agent
   improvements that would not have been found from metadata, Discord, and ordinary
   testing alone.
3. The allowlist and kill switch withstand negative tests, and access/region/retention
   are acceptable.
4. Cloud pricing remains reasonable at measured events/GB, including the fact that AI
   spans and logs are separately metered products.
5. The Collector can fan out to another backend and Coloop code contains no required
   PostHog SDK/domain types.
6. Beta distributed traces and alpha metrics are sufficient as optional views; no
   required capability depends on their stability.

Choose Langfuse instead if dedicated trace graphs, annotation, datasets, or evaluation
workflow materially outperform PostHog. Choose Phoenix if real content needs to remain
on controlled infrastructure and a local single-tenant deployment is acceptable.
Choose Grafana/Honeycomb/SigNoz if operational service telemetry becomes more
important than agent-quality evaluation.

Reject the vendor trial entirely if content does not produce actionable value, the
documented 30-day PostHog content window is unacceptable, metadata cannot be queried
without vendor-specific instrumentation, deletion cannot be verified, or exporter
failure affects Episode behavior.

## Recommendation

1. **Persist v0 with transactional SQLite current-state, inbox, continuation,
   recovery outbox, and narrow transition-audit tables. Do not event-source Episodes.**
2. **Adopt OpenTelemetry plus a Coloop positive-allowlist adapter as the telemetry
   contract.** Keep observability lossy and outside the recovery transaction.
3. **Trial PostHog Cloud first** because the Owner wants to try it and its combined
   logs, AI observability, evaluations, and product analytics are a promising fit.
   Do not self-host PostHog and do not depend on its beta/alpha products.
4. **Keep metadata-only export as the default.** Real completed Discord/Agent content
   is explicit per-installation Owner opt-in with disclosure, restricted access,
   kill switch, and time-boxed retention. Continue to forbid Context Package,
   credentials, IDs, Outcome, tool values, raw errors, and interrupted `RunState` in
   every mode.
5. **Use Langfuse Cloud Hobby as the leading specialist benchmark/fallback.** Its OSS
   edition is free to license but not free to operate. Keep Phoenix as the strongest
   lightweight local/privacy fallback and an OTel-native general stack as the
   operational-observability fallback.
6. **Do not add EventStoreDB/KurrentDB, Kafka/Redpanda, or NATS JetStream.** Revisit a
   stream only after a demonstrated multi-consumer, replay, or scale requirement.

## Remaining uncertainty

- PostHog's public docs establish 30-day removal of large AI properties and ordinary
  product retention, but this research did not find a public guarantee for a shorter
  per-trace TTL or exact project-deletion completion SLA. Verify both before the
  consented-content trial; use a dedicated disposable project.
- PostHog distributed tracing is beta and metrics are alpha, so endpoint and query
  details may change. The OTel adapter/Collector is the mitigation.
- GenAI semantic conventions are still evolving. Version Coloop's `coloop.*`
  attributes and map them at the adapter rather than letting vendor mappings define
  the domain.
- Discord's exact ambiguous-delivery reconciliation and the final local retention
  windows belong to issues #20 and #18; hosted trust/ownership belongs to #22.
- The ticket-27 runtime evidence is deterministic/offline. Live provider behavior can
  still change checkpoint and reconciliation needs, but it does not create a reason
  for event sourcing.
