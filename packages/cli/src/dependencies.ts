import type { CodexIntegrationDependencies } from "@coloop/coding-agent-codex";
import type { DiscordProvider } from "@coloop/discord";
import type { OpenAICredentialProvider } from "@coloop/openai-agents";

export interface ColoopDependencies extends CodexIntegrationDependencies {
  discord: DiscordProvider;
  openExternal(url: string): Promise<void>;
  openai: OpenAICredentialProvider;
  waitForShutdown(): Promise<void>;
}
