import type {
  DiscordApplicationId,
  DiscordChannelId,
  DiscordGuildId,
  DiscordUserId,
} from "../discord-ids.js";
import type { Result } from "../result.js";

export interface InstallationConfig {
  discordApplicationId?: DiscordApplicationId;
  guildId?: DiscordGuildId;
  ownerUserId?: DiscordUserId;
  parentChannelId?: DiscordChannelId;
  schemaVersion: 1;
}

export interface ReadyInstallationConfig extends InstallationConfig {
  discordApplicationId: DiscordApplicationId;
  guildId: DiscordGuildId;
  ownerUserId: DiscordUserId;
  parentChannelId: DiscordChannelId;
}

export const requireReadyInstallation = (
  config: InstallationConfig,
): Result<ReadyInstallationConfig, "installation-incomplete"> => {
  if (
    !config.discordApplicationId ||
    !config.guildId ||
    !config.parentChannelId ||
    !config.ownerUserId
  ) {
    return { ok: false, reason: "installation-incomplete" };
  }
  return {
    ok: true,
    value: {
      discordApplicationId: config.discordApplicationId,
      guildId: config.guildId,
      ownerUserId: config.ownerUserId,
      parentChannelId: config.parentChannelId,
      schemaVersion: config.schemaVersion,
    },
  };
};
