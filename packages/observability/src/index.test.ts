import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createApplicationTelemetry,
  createPrivateTrialTelemetry,
  type TelemetryEnvelope,
} from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content-safe application telemetry", () => {
  test("exports only versioned allowlisted fields to independent destinations", async () => {
    const product: TelemetryEnvelope[] = [];
    const operational: TelemetryEnvelope[] = [];
    const telemetry = createApplicationTelemetry({
      capacity: 4,
      productExporter: async (envelope) => {
        product.push(envelope);
      },
      operationalExporter: async (envelope) => {
        operational.push(envelope);
      },
    });

    expect(
      telemetry.record({
        schemaVersion: 1,
        stream: "product",
        name: "episode.lifecycle",
        occurredAt: "2026-08-29T12:00:00.000Z",
        telemetryEpisodeId: "telemetry-1",
        attributes: { phase: "ACTIVE", result: "succeeded" },
      }),
    ).toEqual({ ok: true });
    expect(
      telemetry.record({
        schemaVersion: 1,
        stream: "operational",
        name: "agent.run",
        occurredAt: "2026-08-29T12:00:01.000Z",
        telemetryEpisodeId: "telemetry-1",
        attributes: {
          result: "failed",
          errorClass: "AGENT_PROVIDER_FAILED",
          latencyMs: 25,
        },
      }),
    ).toEqual({ ok: true });

    await telemetry.flush();
    expect(product).toEqual([
      {
        schemaVersion: 1,
        stream: "product",
        name: "episode.lifecycle",
        occurredAt: "2026-08-29T12:00:00.000Z",
        telemetryEpisodeId: "telemetry-1",
        attributes: { phase: "ACTIVE", result: "succeeded" },
      },
    ]);
    expect(operational).toHaveLength(1);
  });

  test("rejects forbidden content instead of attempting to redact it", () => {
    const telemetry = createApplicationTelemetry({ capacity: 1 });

    expect(
      telemetry.record({
        schemaVersion: 1,
        stream: "product",
        name: "episode.lifecycle",
        occurredAt: "2026-08-29T12:00:00.000Z",
        telemetryEpisodeId: "telemetry-1",
        attributes: { phase: "ACTIVE", contextPackage: "private content" },
      }),
    ).toEqual({
      ok: false,
      reason: "forbidden-field",
      field: "contextPackage",
    });
  });

  test("rejects sensitive values hidden behind allowlisted field names", () => {
    const telemetry = createApplicationTelemetry({ capacity: 1 });

    expect(
      telemetry.record({
        schemaVersion: 1,
        stream: "operational",
        name: "provider.call",
        occurredAt: "2026-08-29T12:00:00.000Z",
        telemetryEpisodeId: "correlation-a",
        attributes: {
          provider: "discord-user-123456789",
          operation: "stream",
          result: "raw error: sk-abcdefghijklmnopqrstuvwxyz123456",
        },
      }),
    ).toEqual({
      ok: false,
      reason: "forbidden-value",
      field: "provider",
    });
  });

  test("drops bounded overflow and exporter failures without throwing", async () => {
    const diagnostics: TelemetryEnvelope[] = [];
    const telemetry = createApplicationTelemetry({
      capacity: 1,
      productExporter: async () => {
        throw new Error("remote unavailable");
      },
      localDiagnostic: (envelope) => {
        diagnostics.push(envelope);
      },
    });
    const event = {
      schemaVersion: 1 as const,
      stream: "product" as const,
      name: "setup.readiness" as const,
      occurredAt: "2026-08-29T12:00:00.000Z",
      attributes: { result: "succeeded", check: "configuration" },
    };

    expect(telemetry.record(event)).toEqual({ ok: true });
    expect(telemetry.record(event)).toEqual({ ok: false, reason: "buffer-full" });
    await expect(telemetry.flush()).resolves.toEqual({
      exported: 0,
      failed: 1,
      dropped: 1,
    });
    expect(
      diagnostics
        .filter(({ name }) => name === "exporter.health")
        .map(({ attributes }) => attributes.result),
    ).toEqual(["dropped", "failed"]);
  });

  test("configures PostHog as the automatically drained product destination", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const telemetry = createPrivateTrialTelemetry({
      capacity: 4,
      postHogProjectApiKey: "phc_project_key",
      postHogHost: "https://us.i.posthog.com",
      installationTelemetryId: "installation-a",
    });

    expect(
      telemetry.record({
        schemaVersion: 1,
        stream: "product",
        name: "owner.pairing",
        occurredAt: "2026-08-29T12:00:00.000Z",
        attributes: { result: "succeeded", authorizationResult: "allowed" },
      }),
    ).toEqual({ ok: true });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]?.[0]).toBe("https://us.i.posthog.com/capture/");
  });
});
