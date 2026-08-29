import type { Result } from "./result.js";

declare const discordApplicationIdBrand: unique symbol;
declare const discordChannelIdBrand: unique symbol;
declare const discordGuildIdBrand: unique symbol;
declare const discordUserIdBrand: unique symbol;

export type DiscordApplicationId = string & {
  readonly [discordApplicationIdBrand]: true;
};
export type DiscordChannelId = string & {
  readonly [discordChannelIdBrand]: true;
};
export type DiscordGuildId = string & {
  readonly [discordGuildIdBrand]: true;
};
export type DiscordUserId = string & {
  readonly [discordUserIdBrand]: true;
};

export type DiscordIdFailure = "invalid-discord-id";

const parseDiscordId = <DiscordId>(
  value: unknown,
): Result<DiscordId, DiscordIdFailure> =>
  typeof value === "string" && /^\d{17,20}$/.test(value)
    ? { ok: true, value: value as DiscordId }
    : { ok: false, reason: "invalid-discord-id" };

export const parseDiscordApplicationId = (
  value: unknown,
): Result<DiscordApplicationId, DiscordIdFailure> =>
  parseDiscordId<DiscordApplicationId>(value);

export const parseDiscordChannelId = (
  value: unknown,
): Result<DiscordChannelId, DiscordIdFailure> =>
  parseDiscordId<DiscordChannelId>(value);

export const parseDiscordGuildId = (
  value: unknown,
): Result<DiscordGuildId, DiscordIdFailure> =>
  parseDiscordId<DiscordGuildId>(value);

export const parseDiscordUserId = (
  value: unknown,
): Result<DiscordUserId, DiscordIdFailure> =>
  parseDiscordId<DiscordUserId>(value);
