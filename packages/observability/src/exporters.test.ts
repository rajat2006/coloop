import { describe, expect, test, vi } from "vitest";
import {
  createOtlpOperationalExporter,
  createPostHogProductExporter,
  type TelemetryEnvelope,
} from "./index.js";

const productEnvelope: TelemetryEnvelope = {
  schemaVersion: 1,
  stream: "product",
  name: "episode.lifecycle",
  occurredAt: "2026-08-29T12:00:00.000Z",
  telemetryEpisodeId: "correlation-a",
  attributes: { phase: "ACTIVE", result: "succeeded" },
};

describe("trial exporters", () => {
  test("sends product analytics to PostHog without a domain Episode identity", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const exporter = createPostHogProductExporter({
      projectApiKey: "phc_project_key",
      host: "https://us.i.posthog.com",
      installationTelemetryId: "installation-a",
      fetch,
    });

    await exporter(productEnvelope);

    expect(fetch).toHaveBeenCalledWith(
      "https://us.i.posthog.com/capture/",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          api_key: "phc_project_key",
          event: "coloop.episode.lifecycle.v1",
          timestamp: "2026-08-29T12:00:00.000Z",
          properties: {
            distinct_id: "correlation-a",
            phase: "ACTIVE",
            result: "succeeded",
          },
        }),
      }),
    );
  });

  test("sends operational envelopes to the local Collector OTLP/HTTP logs path", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const exporter = createOtlpOperationalExporter({
      endpoint: "http://127.0.0.1:4318",
      fetch,
    });

    await exporter({
      ...productEnvelope,
      stream: "operational",
      name: "agent.run",
      attributes: { result: "succeeded", latencyMs: 12 },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/logs",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.stringify(fetch.mock.calls[0]?.[1])).not.toContain("episode-1");
  });

  test("rejects stream mixups and non-success destination responses", async () => {
    const rejectedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const postHog = createPostHogProductExporter({
      projectApiKey: "phc_project_key",
      host: "https://us.i.posthog.com",
      installationTelemetryId: "installation-a",
      fetch: rejectedFetch,
    });
    const otlp = createOtlpOperationalExporter({
      endpoint: "http://127.0.0.1:4318",
      fetch: rejectedFetch,
    });

    await expect(postHog({ ...productEnvelope, stream: "operational" })).rejects.toThrow(
      "PostHog accepts only the content-safe product stream.",
    );
    await expect(otlp(productEnvelope)).rejects.toThrow(
      "OTLP accepts only the content-safe operational stream.",
    );
    await expect(postHog(productEnvelope)).rejects.toThrow(
      "PostHog product export failed.",
    );
    await expect(
      otlp({ ...productEnvelope, stream: "operational", name: "agent.run" }),
    ).rejects.toThrow("OTLP operational export failed.");
  });
});
