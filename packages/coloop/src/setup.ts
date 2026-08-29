import type {
  ColoopDependencies,
  DiscordChannel,
  DiscordGuild,
} from "./dependencies.js";
import { installAndVerifyCodexIntegration } from "./codex-integration.js";
import {
  getInstallationPaths,
  initializePrivateStorage,
  loadConfig,
  saveConfig,
  type InstallationConfig,
} from "./installation.js";
import { Terminal } from "./terminal.js";

export const requiredDiscordPermissions =
  (1n << 10n) |
  (1n << 11n) |
  (1n << 16n) |
  (1n << 31n) |
  (1n << 36n) |
  (1n << 38n);

const isNumericDiscordId = (value: string): boolean => /^\d{17,20}$/.test(value);

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
  if (guilds.length === 1) {
    const guild = guilds[0]!;
    if (!(await terminal.confirm(`Use server ${guild.name} (${guild.id})?`))) {
      throw new Error("Server selection was not confirmed.");
    }
    return guild;
  }
  terminal.line("Available servers:");
  guilds.forEach((guild, index) => terminal.line(`  ${index + 1}. ${guild.name}`));
  const selected = Number(await terminal.ask("Select one server by number: "));
  const guild = guilds[selected - 1];
  if (!guild) {
    throw new Error("A valid server selection is required.");
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

export const verifyPermissions = (channel: DiscordChannel): void => {
  let permissions: bigint;
  try {
    permissions = BigInt(channel.permissions);
  } catch {
    throw new Error("Discord returned an invalid permission set.");
  }
  if ((permissions & (1n << 3n)) !== 0n) {
    throw new Error(
      "Permission check failed: remove Administrator from the dedicated Discord application.",
    );
  }
  if ((permissions & requiredDiscordPermissions) !== requiredDiscordPermissions) {
    throw new Error(
      "Permission check failed: View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Read Message History, and Use Application Commands are required.",
    );
  }
};

export const runSetup = async (
  dependencies: ColoopDependencies,
  terminal: Terminal,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
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
  const config: InstallationConfig = await loadConfig(paths.configFile);

  terminal.line("Discord application");
  let application;
  try {
    application = await dependencies.discord.getApplication(discordToken);
  } catch {
    await openForOwnerAction(
      dependencies,
      "https://discord.com/developers/applications",
    );
    throw new Error("DISCORD_TOKEN was rejected by Discord.");
  }
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
  let guilds: DiscordGuild[];
  try {
    guilds = await dependencies.discord.listGuilds(discordToken);
  } catch {
    throw new Error("Discord server validation failed.");
  }
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
  let channels: DiscordChannel[];
  try {
    channels = await dependencies.discord.listChannels(discordToken, guild.id);
  } catch {
    throw new Error("Discord parent-channel validation failed.");
  }
  let channel = channels.find(
    (candidate) => candidate.id === config.parentChannelId,
  );
  if (channel) {
    terminal.line("Saved parent channel is valid; skipping selection.");
  } else {
    channel = await selectChannel(terminal, channels);
  }
  verifyPermissions(channel);
  config.parentChannelId = channel.id;
  await saveConfig(paths.configFile, config);
  terminal.line(`Parent channel: #${channel.name}`);
  terminal.line("Discord permissions and intents verified.");

  terminal.line();
  terminal.line("Owner Pairing");
  let ownerId = config.ownerUserId;
  let member = ownerId
    ? await dependencies.discord.resolveMember(discordToken, guild.id, ownerId)
    : null;
  if (ownerId && member) {
    terminal.line("Saved Owner Pairing is valid; skipping pairing.");
  }
  if (ownerId && !member) {
    terminal.line(
      "Saved Owner Pairing no longer resolves; pairing a replacement.",
    );
    delete config.ownerUserId;
    await saveConfig(paths.configFile, config);
    ownerId = undefined;
  }
  if (!ownerId) {
    ownerId = await terminal.ask("Enter the Owner's numeric Discord user ID: ");
  }
  if (!isNumericDiscordId(ownerId)) {
    throw new Error("Owner Pairing requires a numeric Discord user ID.");
  }
  member ??= await dependencies.discord.resolveMember(
    discordToken,
    guild.id,
    ownerId,
  );
  if (!member) {
    throw new Error(
      `Discord user ${ownerId} could not be resolved in the configured server.`,
    );
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

  terminal.line();
  terminal.line("OpenAI Platform credential");
  terminal.line(
    "OpenAI Platform credential is separate from Codex CLI authentication.",
  );
  terminal.line(
    "OPENAI_API_KEY belongs to the Owner's Platform project and funds Episode Agent inference.",
  );
  const openaiApiKey = environment.OPENAI_API_KEY;
  if (!openaiApiKey) {
    await openForOwnerAction(
      dependencies,
      "https://platform.openai.com/api-keys",
    );
    throw new Error("OPENAI_API_KEY is required in the process environment.");
  }
  try {
    await dependencies.openai.validateCredential(openaiApiKey);
  } catch {
    await openForOwnerAction(
      dependencies,
      "https://platform.openai.com/api-keys",
    );
    throw new Error("OPENAI_API_KEY was rejected by OpenAI Platform.");
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
  terminal.line("Readiness check passed.");
  terminal.line("Ready. Run `coloop run` to start Coloop.");
};
