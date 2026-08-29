import { requireReadyInstallation } from "@coloop/core";
import { verifyCodexIntegration } from "@coloop/coding-agent-codex";
import {
  verifyChannelIsolation,
  verifyPermissions,
  type DiscordChannel,
  type DiscordGuild,
} from "@coloop/discord";
import {
  getInstallationPaths,
  loadConfig,
  verifyPrivateStorage,
} from "@coloop/local-storage";
import type { ColoopDependencies } from "./dependencies.js";

export type ReadinessFailureReason =
  | "codex-integration-invalid"
  | "configuration-invalid"
  | "discord-application-invalid"
  | "discord-channel-invalid"
  | "discord-credential-missing"
  | "discord-credential-rejected"
  | "discord-owner-invalid"
  | "discord-server-invalid"
  | "openai-credential-missing"
  | "openai-credential-rejected"
  | "openai-unavailable"
  | "storage-invalid";

export interface ReadyRuntime {
  channel: DiscordChannel;
  discordToken: string;
  guild: DiscordGuild;
}

export type ReadinessResult =
  | { readonly ok: true; readonly value: ReadyRuntime }
  | {
      readonly message: string;
      readonly ok: false;
      readonly reason: ReadinessFailureReason;
    };

const failure = (
  reason: ReadinessFailureReason,
  message: string,
): ReadinessResult => ({ message, ok: false, reason });

export const checkReadiness = async (
  dependencies: ColoopDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<ReadinessResult> => {
  const paths = getInstallationPaths(environment);
  const loadedConfig = await loadConfig(paths.configFile);
  if (!loadedConfig.ok) {
    return failure(
      "configuration-invalid",
      "Saved Coloop configuration is unreadable or unsupported.",
    );
  }
  const readyConfig = requireReadyInstallation(loadedConfig.value);
  if (!readyConfig.ok) {
    return failure(
      "configuration-invalid",
      "Coloop is not configured; run `coloop setup` first.",
    );
  }
  const config = readyConfig.value;

  const discordToken = environment.DISCORD_TOKEN;
  if (!discordToken) {
    return failure(
      "discord-credential-missing",
      "DISCORD_TOKEN is required to start Coloop.",
    );
  }
  const openaiApiKey = environment.OPENAI_API_KEY;
  if (!openaiApiKey) {
    return failure(
      "openai-credential-missing",
      "OPENAI_API_KEY is required to start Coloop.",
    );
  }

  const application = await dependencies.discord.getApplication(discordToken);
  if (!application.ok) {
    return application.reason === "credential-rejected"
      ? failure(
          "discord-credential-rejected",
          "DISCORD_TOKEN was rejected by Discord.",
        )
      : failure(
          "discord-application-invalid",
          "Discord application readiness check failed.",
        );
  }
  if (
    application.value.id !== config.discordApplicationId ||
    !application.value.messageContentIntentEnabled
  ) {
    return failure(
      "discord-application-invalid",
      "The saved Discord application or its required intents changed; rerun `coloop setup`.",
    );
  }

  const guilds = await dependencies.discord.listGuilds(discordToken);
  if (!guilds.ok) {
    return failure(
      "discord-server-invalid",
      "Discord server readiness check failed.",
    );
  }
  if (guilds.value.length !== 1) {
    return failure(
      "discord-server-invalid",
      "The dedicated Discord application must remain installed in exactly one server; rerun `coloop setup`.",
    );
  }
  const guild = guilds.value.find(
    (candidate) => candidate.id === config.guildId,
  );
  if (!guild) {
    return failure(
      "discord-server-invalid",
      "The saved Discord server is unavailable; rerun `coloop setup`.",
    );
  }

  const channels = await dependencies.discord.listChannels(
    discordToken,
    guild.id,
  );
  if (!channels.ok) {
    return failure(
      "discord-channel-invalid",
      "Discord parent-channel readiness check failed.",
    );
  }
  const channel = channels.value.find(
    (candidate) => candidate.id === config.parentChannelId,
  );
  if (!channel) {
    return failure(
      "discord-channel-invalid",
      "The saved Discord parent channel is unavailable; rerun `coloop setup`.",
    );
  }
  const permissions = verifyPermissions(channel);
  if (!permissions.ok) {
    return failure("discord-channel-invalid", permissions.message);
  }
  const isolation = verifyChannelIsolation(channels.value, channel);
  if (!isolation.ok) {
    return failure("discord-channel-invalid", isolation.message);
  }

  const owner = await dependencies.discord.resolveMember(
    discordToken,
    guild.id,
    config.ownerUserId,
  );
  if (!owner.ok) {
    return failure(
      "discord-owner-invalid",
      owner.reason === "resource-not-found"
        ? "The paired Owner no longer resolves in the saved server; rerun `coloop setup`."
        : "Discord Owner Pairing readiness check failed.",
    );
  }

  const openai = await dependencies.openai.validateCredential(openaiApiKey);
  if (!openai.ok) {
    return openai.reason === "credential-rejected"
      ? failure(
          "openai-credential-rejected",
          "OPENAI_API_KEY was rejected by OpenAI Platform.",
        )
      : failure(
          "openai-unavailable",
          "OpenAI Platform credential readiness check failed.",
        );
  }

  const storage = await verifyPrivateStorage(paths);
  if (!storage.ok) {
    return failure(
      "storage-invalid",
      "Owner-private SQLite and Episode-artifact storage are not ready; rerun `coloop setup`.",
    );
  }
  const codex = await verifyCodexIntegration(paths.codexHome, dependencies);
  if (!codex.ok) {
    return failure(
      "codex-integration-invalid",
      "Codex integration is not ready; rerun `coloop setup`.",
    );
  }

  return { ok: true, value: { channel, discordToken, guild } };
};
