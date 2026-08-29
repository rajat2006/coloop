export interface InstallationConfig {
  discordApplicationId?: string;
  guildId?: string;
  ownerUserId?: string;
  parentChannelId?: string;
  schemaVersion: 1;
}

export interface ReadyInstallationConfig extends InstallationConfig {
  discordApplicationId: string;
  guildId: string;
  ownerUserId: string;
  parentChannelId: string;
}

export const requireReadyInstallation = (
  config: InstallationConfig,
): ReadyInstallationConfig => {
  if (
    !config.discordApplicationId ||
    !config.guildId ||
    !config.parentChannelId ||
    !config.ownerUserId
  ) {
    throw new Error("Coloop is not configured; run `coloop setup` first.");
  }
  return {
    discordApplicationId: config.discordApplicationId,
    guildId: config.guildId,
    ownerUserId: config.ownerUserId,
    parentChannelId: config.parentChannelId,
    schemaVersion: config.schemaVersion,
  };
};
