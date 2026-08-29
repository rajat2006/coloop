import type { TelemetryEnvelope } from "./index.js";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createPostHogProductExporter(configuration: {
  readonly projectApiKey: string;
  readonly host: string;
  readonly installationTelemetryId: string;
  readonly fetch?: Fetch;
}): (envelope: TelemetryEnvelope) => Promise<void> {
  const request = configuration.fetch ?? fetch;
  const endpoint = new URL("/capture/", withTrailingSlash(configuration.host));
  return async (envelope) => {
    if (envelope.stream !== "product") {
      throw new Error("PostHog accepts only the content-safe product stream.");
    }
    const response = await request(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: configuration.projectApiKey,
        event: `coloop.${envelope.name}.v${envelope.schemaVersion}`,
        timestamp: envelope.occurredAt,
        properties: {
          distinct_id:
            envelope.telemetryEpisodeId ?? configuration.installationTelemetryId,
          ...envelope.attributes,
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error("PostHog product export failed.");
    }
    await response.body?.cancel();
  };
}

export function createOtlpOperationalExporter(configuration: {
  readonly endpoint: string;
  readonly fetch?: Fetch;
}): (envelope: TelemetryEnvelope) => Promise<void> {
  const request = configuration.fetch ?? fetch;
  const endpoint = new URL("v1/logs", withTrailingSlash(configuration.endpoint));
  return async (envelope) => {
    if (envelope.stream !== "operational") {
      throw new Error("OTLP accepts only the content-safe operational stream.");
    }
    const attributes = Object.entries(envelope.attributes).map(([key, value]) => ({
      key,
      value: toOtlpValue(value),
    }));
    if (envelope.telemetryEpisodeId !== undefined) {
      attributes.push({
        key: "coloop.telemetry_episode_id",
        value: { stringValue: envelope.telemetryEpisodeId },
      });
    }
    const response = await request(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "coloop" } },
                {
                  key: "telemetry.schema.version",
                  value: { intValue: String(envelope.schemaVersion) },
                },
              ],
            },
            scopeLogs: [
              {
                scope: { name: "@coloop/observability" },
                logRecords: [
                  {
                    timeUnixNano: toUnixNanoseconds(envelope.occurredAt),
                    severityText: "INFO",
                    body: { stringValue: envelope.name },
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error("OTLP operational export failed.");
    }
    await response.body?.cancel();
  };
}

function toOtlpValue(value: string | number | boolean):
  | { readonly stringValue: string }
  | { readonly doubleValue: number }
  | { readonly boolValue: boolean } {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { doubleValue: value };
  return { boolValue: value };
}

function toUnixNanoseconds(timestamp: string): string {
  return String(BigInt(Date.parse(timestamp)) * 1_000_000n);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
