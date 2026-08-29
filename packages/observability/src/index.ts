export type TelemetryStream = "product" | "operational";

export {
  createPrivateAgentTracePolicy,
  containsRecognizedCredential,
  type PrivateAgentTraceDecision,
  type PrivateAgentTracePolicy,
} from "./private-agent-tracing.js";
export {
  createOtlpOperationalExporter,
  createPostHogProductExporter,
} from "./exporters.js";
import {
  createOtlpOperationalExporter,
  createPostHogProductExporter,
} from "./exporters.js";

export type TelemetryEventName =
  | "setup.readiness"
  | "owner.pairing"
  | "episode.lifecycle"
  | "episode.control"
  | "episode.return"
  | "agent.run"
  | "discord.gateway"
  | "delivery"
  | "sqlite.operation"
  | "provider.call"
  | "exporter.health";

type TelemetryAttribute = string | number | boolean;

export interface TelemetryEnvelope {
  readonly schemaVersion: 1;
  readonly stream: TelemetryStream;
  readonly name: TelemetryEventName;
  readonly occurredAt: string;
  readonly telemetryEpisodeId?: string;
  readonly attributes: Readonly<Record<string, TelemetryAttribute>>;
}

export type TelemetryRecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "buffer-full" }
  | {
      readonly ok: false;
      readonly reason: "forbidden-field";
      readonly field: string;
    }
  | {
      readonly ok: false;
      readonly reason: "forbidden-value";
      readonly field: string;
    }
  | { readonly ok: false; readonly reason: "invalid-envelope" };

export interface ApplicationTelemetry {
  record(envelope: unknown): TelemetryRecordResult;
  flush(): Promise<{
    readonly exported: number;
    readonly failed: number;
    readonly dropped: number;
  }>;
}

type TelemetryExporter = (envelope: TelemetryEnvelope) => Promise<void>;

interface ApplicationTelemetryConfiguration {
  readonly capacity: number;
  readonly productExporter?: TelemetryExporter;
  readonly operationalExporter?: TelemetryExporter;
  readonly localDiagnostic?: (envelope: TelemetryEnvelope) => void;
}

const streamsByName: Readonly<Record<TelemetryEventName, TelemetryStream>> = {
  "setup.readiness": "product",
  "owner.pairing": "product",
  "episode.lifecycle": "product",
  "episode.control": "product",
  "episode.return": "product",
  "agent.run": "operational",
  "discord.gateway": "operational",
  delivery: "operational",
  "sqlite.operation": "operational",
  "provider.call": "operational",
  "exporter.health": "operational",
};

const allowedAttributes: Readonly<Record<TelemetryEventName, readonly string[]>> = {
  "setup.readiness": ["result", "check", "errorClass", "latencyMs"],
  "owner.pairing": ["result", "authorizationResult"],
  "episode.lifecycle": ["phase", "result", "created"],
  "episode.control": ["control", "result", "authorizationResult"],
  "episode.return": ["result"],
  "agent.run": ["result", "errorClass", "latencyMs", "acceptedTurns"],
  "discord.gateway": ["result", "errorClass", "latencyMs"],
  delivery: ["destination", "result", "errorClass", "latencyMs"],
  "sqlite.operation": ["operation", "result", "errorClass", "latencyMs"],
  "provider.call": ["provider", "operation", "result", "errorClass", "latencyMs"],
  "exporter.health": ["destination", "result", "errorClass", "droppedCount"],
};

const requiredAttributes: Readonly<Record<TelemetryEventName, readonly string[]>> = {
  "setup.readiness": ["result", "check"],
  "owner.pairing": ["result", "authorizationResult"],
  "episode.lifecycle": ["phase", "result"],
  "episode.control": ["control", "result", "authorizationResult"],
  "episode.return": ["result"],
  "agent.run": ["result"],
  "discord.gateway": ["result"],
  delivery: ["destination", "result"],
  "sqlite.operation": ["operation", "result"],
  "provider.call": ["provider", "operation", "result"],
  "exporter.health": ["destination", "result"],
};

export function createApplicationTelemetry(
  configuration: ApplicationTelemetryConfiguration,
): ApplicationTelemetry {
  if (!Number.isSafeInteger(configuration.capacity) || configuration.capacity < 1) {
    throw new Error("Telemetry buffer capacity must be a positive integer.");
  }
  const buffer: TelemetryEnvelope[] = [];
  let dropped = 0;
  let flushScheduled = false;
  let flushInFlight:
    | Promise<{ readonly exported: number; readonly failed: number; readonly dropped: number }>
    | undefined;

  const telemetry: ApplicationTelemetry = {
    record(value): TelemetryRecordResult {
      const parsed = parseEnvelope(value);
      if (!parsed.ok) return parsed;
      reportLocalDiagnostic(configuration, parsed.envelope);
      const exporter = parsed.envelope.stream === "product"
        ? configuration.productExporter
        : configuration.operationalExporter;
      if (exporter === undefined) return { ok: true };
      if (buffer.length >= configuration.capacity) {
        dropped += 1;
        reportExporterHealth(configuration, parsed.envelope, "dropped", "buffer-full");
        return { ok: false, reason: "buffer-full" };
      }
      buffer.push(parsed.envelope);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          flushScheduled = false;
          void telemetry.flush();
        });
      }
      return { ok: true };
    },

    flush() {
      if (flushInFlight !== undefined) return flushInFlight;
      const operation = (async () => {
        try {
          let exported = 0;
          let failed = 0;
          while (buffer.length > 0) {
            const pending = buffer.splice(0);
            for (const envelope of pending) {
              const exporter = envelope.stream === "product"
                ? configuration.productExporter
                : configuration.operationalExporter;
              if (exporter === undefined) continue;
              try {
                await exporter(envelope);
                exported += 1;
              } catch {
                failed += 1;
                reportExporterHealth(configuration, envelope, "failed", "export-failed");
              }
            }
          }
          const result = { exported, failed, dropped };
          dropped = 0;
          return result;
        } finally {
          flushInFlight = undefined;
        }
      })();
      flushInFlight = operation;
      return operation;
    },
  };
  return telemetry;
}

function reportExporterHealth(
  configuration: ApplicationTelemetryConfiguration,
  source: TelemetryEnvelope,
  result: "failed" | "dropped",
  errorClass: "export-failed" | "buffer-full",
): void {
  reportLocalDiagnostic(configuration, {
    schemaVersion: 1,
    stream: "operational",
    name: "exporter.health",
    occurredAt: new Date().toISOString(),
    ...(source.telemetryEpisodeId === undefined
      ? {}
      : { telemetryEpisodeId: source.telemetryEpisodeId }),
    attributes: {
      destination: source.stream === "product" ? "posthog" : "otlp",
      result,
      errorClass,
      ...(result === "dropped" ? { droppedCount: 1 } : {}),
    },
  });
}

function reportLocalDiagnostic(
  configuration: ApplicationTelemetryConfiguration,
  envelope: TelemetryEnvelope,
): void {
  try {
    configuration.localDiagnostic?.(envelope);
  } catch {
    // Local diagnostic adapters are observational and cannot affect callers.
  }
}

export function createPrivateTrialTelemetry(configuration: {
  readonly capacity: number;
  readonly postHogProjectApiKey: string;
  readonly postHogHost: string;
  readonly installationTelemetryId: string;
  readonly otlpEndpoint?: string;
  readonly localDiagnostic?: (envelope: TelemetryEnvelope) => void;
}): ApplicationTelemetry {
  return createApplicationTelemetry({
    capacity: configuration.capacity,
    productExporter: createPostHogProductExporter({
      projectApiKey: configuration.postHogProjectApiKey,
      host: configuration.postHogHost,
      installationTelemetryId: configuration.installationTelemetryId,
    }),
    ...(configuration.otlpEndpoint === undefined
      ? {}
      : {
          operationalExporter: createOtlpOperationalExporter({
            endpoint: configuration.otlpEndpoint,
          }),
        }),
    ...(configuration.localDiagnostic === undefined
      ? {}
      : { localDiagnostic: configuration.localDiagnostic }),
  });
}

function parseEnvelope(value: unknown):
  | { readonly ok: true; readonly envelope: TelemetryEnvelope }
  | Exclude<TelemetryRecordResult, { readonly ok: true }> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.stream !== "product" && value.stream !== "operational") ||
    !isTelemetryEventName(value.name) ||
    streamsByName[value.name] !== value.stream ||
    !isIsoTimestamp(value.occurredAt) ||
    (value.telemetryEpisodeId !== undefined &&
      !isNonEmptyString(value.telemetryEpisodeId)) ||
    !isRecord(value.attributes)
  ) {
    return { ok: false, reason: "invalid-envelope" };
  }
  const allowed = allowedAttributes[value.name];
  const attributes: Record<string, TelemetryAttribute> = {};
  for (const [field, attribute] of Object.entries(value.attributes)) {
    if (!allowed.includes(field)) {
      return { ok: false, reason: "forbidden-field", field };
    }
    if (
      typeof attribute !== "string" &&
      typeof attribute !== "number" &&
      typeof attribute !== "boolean"
    ) {
      return { ok: false, reason: "invalid-envelope" };
    }
    if (!isAllowedAttributeValue(field, attribute)) {
      return { ok: false, reason: "forbidden-value", field };
    }
    attributes[field] = attribute;
  }
  for (const field of requiredAttributes[value.name]) {
    if (!(field in attributes)) {
      return { ok: false, reason: "invalid-envelope" };
    }
  }
  return {
    ok: true,
    envelope: {
      schemaVersion: 1,
      stream: value.stream,
      name: value.name,
      occurredAt: value.occurredAt,
      ...(value.telemetryEpisodeId === undefined
        ? {}
        : { telemetryEpisodeId: value.telemetryEpisodeId }),
      attributes,
    },
  };
}

function isAllowedAttributeValue(
  field: string,
  value: TelemetryAttribute,
): boolean {
  switch (field) {
    case "phase":
      return isOneOf(value, ["OPENING", "ACTIVE", "FINALIZED", "CANCELLED"]);
    case "result":
      return isOneOf(value, [
        "succeeded",
        "failed",
        "interrupted",
        "rejected",
        "duplicate",
        "ignored",
        "dropped",
        "unavailable",
      ]);
    case "check":
      return isOneOf(value, [
        "configuration",
        "local-storage",
        "discord-credential",
        "openai-credential",
        "owner-pairing",
        "codex-integration",
      ]);
    case "errorClass":
      return isOneOf(value, [
        "RUNTIME_INTERRUPTED",
        "DISCORD_GATEWAY_INTERRUPTED",
        "AGENT_PROVIDER_FAILED",
        "AGENT_CONTINUATION_REJECTED",
        "DISCORD_DELIVERY_AMBIGUOUS",
        "credential-rejected",
        "provider-unavailable",
        "database-failed",
        "export-failed",
        "buffer-full",
      ]);
    case "authorizationResult":
      return isOneOf(value, ["allowed", "denied"]);
    case "control":
      return isOneOf(value, ["open", "get", "cancel", "finalize"]);
    case "destination":
      return isOneOf(value, [
        "discord",
        "codex",
        "posthog",
        "otlp",
        "local-diagnostics",
      ]);
    case "provider":
      return isOneOf(value, ["discord", "openai", "posthog", "otlp", "sqlite"]);
    case "operation":
      return isOneOf(value, [
        "setup",
        "pair",
        "open",
        "get",
        "cancel",
        "finalize",
        "stream",
        "synthesize",
        "return",
        "read",
        "write",
        "export",
      ]);
    case "latencyMs":
      return isBoundedNumber(value, 86_400_000);
    case "acceptedTurns":
      return isBoundedInteger(value, 300);
    case "droppedCount":
      return isBoundedInteger(value, 1_000_000);
    case "created":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function isOneOf(
  value: TelemetryAttribute,
  allowed: readonly string[],
): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isBoundedNumber(value: TelemetryAttribute, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function isBoundedInteger(value: TelemetryAttribute, maximum: number): boolean {
  return isBoundedNumber(value, maximum) && Number.isSafeInteger(value);
}

function isTelemetryEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && value in streamsByName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
