import { describe, expect, test } from "vitest";
import {
  createApplicationTelemetry,
  type TelemetryEnvelope,
} from "./index.js";

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
        attributes: { result: "provider-failed", latencyMs: 25 },
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

  test("drops bounded overflow and exporter failures without throwing", async () => {
    const telemetry = createApplicationTelemetry({
      capacity: 1,
      productExporter: async () => {
        throw new Error("remote unavailable");
      },
    });
    const event = {
      schemaVersion: 1 as const,
      stream: "product" as const,
      name: "setup.readiness" as const,
      occurredAt: "2026-08-29T12:00:00.000Z",
      attributes: { result: "succeeded" },
    };

    expect(telemetry.record(event)).toEqual({ ok: true });
    expect(telemetry.record(event)).toEqual({ ok: false, reason: "buffer-full" });
    await expect(telemetry.flush()).resolves.toEqual({
      exported: 0,
      failed: 1,
      dropped: 1,
    });
  });
});
