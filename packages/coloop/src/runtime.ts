import { verifyCodexIntegration } from "./codex-integration.js";
import type {
  ColoopDependencies,
  DiscordChannel,
  DiscordGuild,
} from "./dependencies.js";
import {
  getInstallationPaths,
  loadConfig,
  verifyPrivateStorage,
} from "./installation.js";
import { verifyPermissions } from "./setup.js";
import { Terminal } from "./terminal.js";

export const runRuntime = async (
  dependencies: ColoopDependencies,
  terminal: Terminal,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  terminal.line("Coloop runtime startup");
  const paths = getInstallationPaths(environment);
  const config = await loadConfig(paths.configFile);
  if (
    !config.discordApplicationId ||
    !config.guildId ||
    !config.parentChannelId ||
    !config.ownerUserId
  ) {
    throw new Error("Coloop is not configured; run `coloop setup` first.");
  }

  const discordToken = environment.DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is required to start Coloop.");
  }
  const openaiApiKey = environment.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required to start Coloop.");
  }

  let application;
  try {
    application = await dependencies.discord.getApplication(discordToken);
  } catch {
    throw new Error("DISCORD_TOKEN was rejected by Discord.");
  }
  if (
    application.id !== config.discordApplicationId ||
    !application.messageContentIntentEnabled
  ) {
    throw new Error(
      "The saved Discord application or its required intents changed; rerun `coloop setup`.",
    );
  }

  let guilds: DiscordGuild[];
  try {
    guilds = await dependencies.discord.listGuilds(discordToken);
  } catch {
    throw new Error("Discord server readiness check failed.");
  }
  const guild = guilds.find((candidate) => candidate.id === config.guildId);
  if (!guild) {
    throw new Error("The saved Discord server is unavailable; rerun `coloop setup`.");
  }
  let channels: DiscordChannel[];
  try {
    channels = await dependencies.discord.listChannels(discordToken, guild.id);
  } catch {
    throw new Error("Discord parent-channel readiness check failed.");
  }
  const channel = channels.find(
    (candidate) => candidate.id === config.parentChannelId,
  );
  if (!channel) {
    throw new Error(
      "The saved Discord parent channel is unavailable; rerun `coloop setup`.",
    );
  }
  verifyPermissions(channel);
  const owner = await dependencies.discord.resolveMember(
    discordToken,
    guild.id,
    config.ownerUserId,
  );
  if (!owner) {
    throw new Error(
      "The paired Owner no longer resolves in the saved server; rerun `coloop setup`.",
    );
  }

  try {
    await dependencies.openai.validateCredential(openaiApiKey);
  } catch {
    throw new Error("OPENAI_API_KEY was rejected by OpenAI Platform.");
  }
  await verifyPrivateStorage(paths);
  await verifyCodexIntegration(paths.codexHome, dependencies);
  terminal.line("Readiness check passed.");

  let gateway;
  try {
    gateway = await dependencies.discord.connectGateway(discordToken);
  } catch {
    throw new Error("Discord Gateway startup failed.");
  }
  terminal.line(
    `Coloop is running in the foreground for ${guild.name}/#${channel.name}.`,
  );
  try {
    await dependencies.waitForShutdown();
  } finally {
    await gateway.close();
  }
};
