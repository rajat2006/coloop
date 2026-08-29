export type TelemetryStream = "product" | "operational";

export {
  createPrivateAgentTracePolicy,
  type PrivateAgentTraceDecision,
  type PrivateAgentTracePolicy,
} from "./private-agent-tracing.js";
export {
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

export function createApplicationTelemetry(
  configuration: ApplicationTelemetryConfiguration,
): ApplicationTelemetry {
  if (!Number.isSafeInteger(configuration.capacity) || configuration.capacity < 1) {
    throw new Error("Telemetry buffer capacity must be a positive integer.");
  }
  const buffer: TelemetryEnvelope[] = [];
  let dropped = 0;

  return {
    record(value): TelemetryRecordResult {
      const parsed = parseEnvelope(value);
      if (!parsed.ok) return parsed;
      configuration.localDiagnostic?.(parsed.envelope);
      const exporter = parsed.envelope.stream === "product"
        ? configuration.productExporter
        : configuration.operationalExporter;
      if (exporter === undefined) return { ok: true };
      if (buffer.length >= configuration.capacity) {
        dropped += 1;
        return { ok: false, reason: "buffer-full" };
      }
      buffer.push(parsed.envelope);
      return { ok: true };
    },

    async flush() {
      const pending = buffer.splice(0);
      let exported = 0;
      let failed = 0;
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
        }
      }
      const result = { exported, failed, dropped };
      dropped = 0;
      return result;
    },
  };
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
    attributes[field] = attribute;
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
