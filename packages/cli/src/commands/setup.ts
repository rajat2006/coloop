import {
  parseDiscordUserId,
  type InstallationConfig,
} from "@coloop/core";
import { installAndVerifyCodexIntegration } from "@coloop/coding-agent-codex";
import {
  requiredDiscordPermissions,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMember,
  verifyChannelIsolation,
  verifyPermissions,
} from "@coloop/discord";
import {
  getInstallationPaths,
  initializePrivateStorage,
  loadConfig,
  saveConfig,
} from "@coloop/local-storage";
import type { ColoopDependencies } from "../dependencies.js";
import { Terminal } from "../terminal/terminal.js";
import { recordTelemetry } from "../telemetry.js";

const openForOwnerAction = async (
  dependencies: ColoopDependencies,
  url: string,
): Promise<void> => {
  try {
    await dependencies.openExternal(url);
  } catch {
    // The actionable error remains useful when a graphical browser is unavailable.
  }
};

const selectGuild = async (
  terminal: Terminal,
  guilds: DiscordGuild[],
): Promise<DiscordGuild> => {
  if (guilds.length === 0) {
    throw new Error("The Discord application is not installed in a server.");
  }
  if (guilds.length > 1) {
    throw new Error(
      "Remove the dedicated Discord application from every other server, leaving exactly one allowed server, then rerun setup.",
    );
  }
  const guild = guilds[0]!;
  if (!(await terminal.confirm(`Use server ${guild.name} (${guild.id})?`))) {
    throw new Error("Server selection was not confirmed.");
  }
  return guild;
};

const selectChannel = async (
  terminal: Terminal,
  channels: DiscordChannel[],
): Promise<DiscordChannel> => {
  const textChannels = channels.filter((channel) => channel.type === "GUILD_TEXT");
  if (textChannels.length === 0) {
    throw new Error("No text channel is available for private Collaboration Episodes.");
  }
  if (textChannels.length === 1) {
    const channel = textChannels[0]!;
    if (!(await terminal.confirm(`Use parent channel #${channel.name} (${channel.id})?`))) {
      throw new Error("Parent channel selection was not confirmed.");
    }
    return channel;
  }
  terminal.line("Available parent channels:");
  textChannels.forEach((channel, index) =>
    terminal.line(`  ${index + 1}. #${channel.name}`),
  );
  const selected = Number(await terminal.ask("Select one channel by number: "));
  const channel = textChannels[selected - 1];
  if (!channel) {
    throw new Error("A valid parent channel selection is required.");
  }
  return channel;
};

export const runSetup = async (
  dependencies: ColoopDependencies,
  terminal: Terminal,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  // Each validated non-secret step is saved immediately so setup can resume safely.
  terminal.line("Coloop setup");
  terminal.line();
  const discordToken = environment.DISCORD_TOKEN;
  if (!discordToken) {
    await openForOwnerAction(
      dependencies,
      "https://discord.com/developers/applications",
    );
    throw new Error(
      "DISCORD_TOKEN is required in the process environment. Create a dedicated Discord application, then rerun setup.",
    );
  }

  const paths = getInstallationPaths(environment);
  const loadedConfig = await loadConfig(paths.configFile);
  if (!loadedConfig.ok) {
    throw new Error("Saved Coloop configuration is unreadable or unsupported.");
  }
  const config: InstallationConfig = loadedConfig.value;

  terminal.line("Discord application");
  const applicationResult =
    await dependencies.discord.getApplication(discordToken);
  if (!applicationResult.ok) {
    if (applicationResult.reason === "credential-rejected") {
      await openForOwnerAction(
        dependencies,
        "https://discord.com/developers/applications",
      );
      throw new Error("DISCORD_TOKEN was rejected by Discord.");
    }
    throw new Error(
      "Discord application validation is temporarily unavailable; rerun setup without changing credentials.",
    );
  }
  const application = applicationResult.value;
  terminal.line(`Discord application: ${application.name}`);
  terminal.line("Required intents: Guilds, Guild Messages, Message Content.");
  terminal.line(
    "Required permissions: View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Read Message History, Use Application Commands.",
  );
  if (!application.messageContentIntentEnabled) {
    await openForOwnerAction(
      dependencies,
      `https://discord.com/developers/applications/${application.id}/bot`,
    );
    throw new Error(
      "Enable the Guilds, Guild Messages, and Message Content intents for the dedicated Discord application, then rerun setup.",
    );
  }
  if (config.discordApplicationId === application.id) {
    terminal.line("Saved Discord application is valid; skipping configuration.");
  } else {
    if (!(await terminal.confirm("Is this the dedicated Coloop application?"))) {
      throw new Error("A dedicated Discord application must be confirmed.");
    }
  }
  config.discordApplicationId = application.id;
  await saveConfig(paths.configFile, config);

  terminal.line();
  terminal.line("Allowed Discord server");
  const guildsResult = await dependencies.discord.listGuilds(discordToken);
  if (!guildsResult.ok) {
    throw new Error("Discord server validation failed.");
  }
  const guilds = guildsResult.value;
  if (guilds.length === 0) {
    const installer = new URL("https://discord.com/oauth2/authorize");
    installer.searchParams.set("client_id", application.id);
    installer.searchParams.set("scope", "bot applications.commands");
    installer.searchParams.set(
      "permissions",
      requiredDiscordPermissions.toString(),
    );
    await openForOwnerAction(dependencies, installer.toString());
    throw new Error("The Discord application is not installed in a server.");
  }
  if (guilds.length > 1) {
    throw new Error(
      "Remove the dedicated Discord application from every other server, leaving exactly one allowed server, then rerun setup.",
    );
  }
  let guild = guilds.find((candidate) => candidate.id === config.guildId);
  if (guild) {
    terminal.line("Saved server is valid; skipping selection.");
  } else {
    guild = await selectGuild(terminal, guilds);
  }
  config.guildId = guild.id;
  await saveConfig(paths.configFile, config);
  terminal.line(`Server: ${guild.name}`);

  terminal.line();
  terminal.line("Parent channel and least-privilege permissions");
  const channelsResult = await dependencies.discord.listChannels(
    discordToken,
    guild.id,
  );
  if (!channelsResult.ok) {
    throw new Error("Discord parent-channel validation failed.");
  }
  const channels = channelsResult.value;
  let channel = channels.find(
    (candidate) => candidate.id === config.parentChannelId,
  );
  if (channel) {
    terminal.line("Saved parent channel is valid; skipping selection.");
  } else {
    channel = await selectChannel(terminal, channels);
  }
  const permissions = verifyPermissions(channel);
  if (!permissions.ok) throw new Error(permissions.message);
  const isolation = verifyChannelIsolation(channels, channel);
  if (!isolation.ok) throw new Error(isolation.message);
  config.parentChannelId = channel.id;
  await saveConfig(paths.configFile, config);
  terminal.line(`Parent channel: #${channel.name}`);
  terminal.line("Discord permissions and intents verified.");

  terminal.line();
  terminal.line("Owner Pairing");
  // A transient lookup failure must not erase a pairing that may still be valid.
  let ownerId = config.ownerUserId;
  let member: DiscordMember | undefined;
  if (ownerId) {
    const savedMember = await dependencies.discord.resolveMember(
      discordToken,
      guild.id,
      ownerId,
    );
    if (savedMember.ok) {
      member = savedMember.value;
      terminal.line("Saved Owner Pairing is valid; skipping pairing.");
    } else if (savedMember.reason === "resource-not-found") {
      terminal.line(
        "Saved Owner Pairing no longer resolves; pairing a replacement.",
      );
      delete config.ownerUserId;
      await saveConfig(paths.configFile, config);
      ownerId = undefined;
    } else {
      throw new Error(
        "Discord Owner Pairing validation is temporarily unavailable; saved pairing was not changed.",
      );
    }
  }
  if (!ownerId) {
    const parsedOwnerId = parseDiscordUserId(
      await terminal.ask("Enter the Owner's numeric Discord user ID: "),
    );
    if (!parsedOwnerId.ok) {
      throw new Error("Owner Pairing requires a numeric Discord user ID.");
    }
    ownerId = parsedOwnerId.value;
  }
  if (!member) {
    const resolvedMember = await dependencies.discord.resolveMember(
      discordToken,
      guild.id,
      ownerId,
    );
    if (!resolvedMember.ok) {
      if (resolvedMember.reason === "resource-not-found") {
        throw new Error(
          `Discord user ${ownerId} could not be resolved in the configured server.`,
        );
      }
      throw new Error(
        "Discord Owner Pairing validation is temporarily unavailable; saved pairing was not changed.",
      );
    }
    member = resolvedMember.value;
  }
  terminal.line(
    `Resolved Owner: ${member.displayName} (@${member.username}, ${member.id})`,
  );
  if (
    config.ownerUserId !== ownerId &&
    !(await terminal.confirm("Pair this exact Discord account as the Owner?"))
  ) {
    throw new Error("Owner Pairing was not confirmed.");
  }
  config.ownerUserId = ownerId;
  await saveConfig(paths.configFile, config);
  recordTelemetry(dependencies, {
    schemaVersion: 1,
    stream: "product",
    name: "owner.pairing",
    occurredAt: new Date().toISOString(),
    attributes: { result: "succeeded", authorizationResult: "allowed" },
  });

  terminal.line();
  terminal.line("OpenAI Platform credential");
  terminal.line(
    "OpenAI Platform credential is separate from Codex CLI authentication.",
  );
  terminal.line(
    "OPENAI_API_KEY belongs to the Owner's Platform project and funds Episode Agent inference.",
  );
  // Provider credentials are read from the environment for validation and are never persisted.
  const openaiApiKey = environment.OPENAI_API_KEY;
  if (!openaiApiKey) {
    await openForOwnerAction(
      dependencies,
      "https://platform.openai.com/api-keys",
    );
    throw new Error("OPENAI_API_KEY is required in the process environment.");
  }
  const openaiCredential =
    await dependencies.openai.validateCredential(openaiApiKey);
  if (!openaiCredential.ok) {
    if (openaiCredential.reason === "credential-rejected") {
      await openForOwnerAction(
        dependencies,
        "https://platform.openai.com/api-keys",
      );
      throw new Error("OPENAI_API_KEY was rejected by OpenAI Platform.");
    }
    throw new Error(
      "OpenAI Platform credential validation is temporarily unavailable; rerun setup without changing credentials.",
    );
  }
  terminal.line("OpenAI Platform credential verified.");

  terminal.line();
  terminal.line("Owner-private storage");
  await initializePrivateStorage(paths);
  terminal.line("SQLite state and Episode-artifact storage initialized.");

  terminal.line();
  terminal.line("Codex CLI integration");
  terminal.line(
    "Only the supported Codex CLI is configured; IDE and desktop clients are not supported in v0.",
  );
  await installAndVerifyCodexIntegration(paths.codexHome, dependencies);
  terminal.line("Codex CLI hook and MCP entry points verified for CLI 0.150.1.");

  terminal.line();
  // Every prerequisite above was verified as it was saved, so avoid repeating provider calls.
  terminal.line("Readiness check passed.");
  terminal.line("Ready. Run `coloop run` to start Coloop.");
  recordTelemetry(dependencies, {
    schemaVersion: 1,
    stream: "product",
    name: "setup.readiness",
    occurredAt: new Date().toISOString(),
    attributes: { result: "succeeded", check: "configuration" },
  });
};
