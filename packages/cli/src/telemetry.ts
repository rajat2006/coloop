import type { TelemetryEnvelope } from "@coloop/observability";
import type { ColoopDependencies } from "./dependencies.js";

export function recordTelemetry(
  dependencies: ColoopDependencies,
  envelope: TelemetryEnvelope,
): void {
  try {
    dependencies.telemetry?.record(envelope);
  } catch {
    // Optional telemetry cannot affect setup or runtime readiness.
  }
}
