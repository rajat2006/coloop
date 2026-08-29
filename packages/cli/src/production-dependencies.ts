import type { CommandInvocation } from "@coloop/coding-agent-codex";
import { randomUUID } from "node:crypto";
import { createDiscordProvider } from "@coloop/discord";
import { createOpenAICredentialProvider } from "@coloop/openai-agents";
import { createPrivateTrialTelemetry } from "@coloop/observability";
import type { ColoopDependencies } from "./dependencies.js";
import { openExternal } from "./system/open-browser.js";
import { runCodex, runColoop } from "./system/processes.js";
import { waitForShutdown } from "./system/shutdown.js";

export const createProductionDependencies = (
  coloopEntrypoint: CommandInvocation,
  environment: NodeJS.ProcessEnv = {},
): ColoopDependencies => ({
  coloopEntrypoint,
  discord: createDiscordProvider(),
  openExternal,
  openai: createOpenAICredentialProvider(),
  ...(environment.POSTHOG_PROJECT_API_KEY === undefined
    ? {}
    : {
        telemetry: createPrivateTrialTelemetry({
          capacity: 256,
          postHogProjectApiKey: environment.POSTHOG_PROJECT_API_KEY,
          postHogHost: environment.POSTHOG_HOST ?? "https://us.i.posthog.com",
          installationTelemetryId: randomUUID(),
          otlpEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
        }),
      }),
  runCodex,
  runColoop: async (args, input) =>
    await runColoop(coloopEntrypoint, args, input),
  waitForShutdown,
});
