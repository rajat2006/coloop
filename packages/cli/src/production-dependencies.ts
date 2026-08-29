import type { CommandInvocation } from "@coloop/coding-agent-codex";
import { createDiscordProvider } from "@coloop/discord";
import { createOpenAICredentialProvider } from "@coloop/openai-agents";
import type { ColoopDependencies } from "./dependencies.js";
import { openExternal } from "./system/open-browser.js";
import { runCodex, runColoop } from "./system/processes.js";
import { waitForShutdown } from "./system/shutdown.js";

export const createProductionDependencies = (
  coloopEntrypoint: CommandInvocation,
): ColoopDependencies => ({
  coloopEntrypoint,
  discord: createDiscordProvider(),
  openExternal,
  openai: createOpenAICredentialProvider(),
  runCodex,
  runColoop: async (args, input) =>
    await runColoop(coloopEntrypoint, args, input),
  waitForShutdown,
});
