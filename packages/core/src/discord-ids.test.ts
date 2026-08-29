import { describe, expect, test } from "vitest";
import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
} from "./discord-ids.js";

describe("Discord identifiers", () => {
  test.each([
    parseDiscordApplicationId,
    parseDiscordChannelId,
    parseDiscordGuildId,
    parseDiscordUserId,
  ])("accepts a Discord snowflake", (parse) => {
    expect(parse("123456789012345678")).toEqual({
      ok: true,
      value: "123456789012345678",
    });
  });

  test.each([
    parseDiscordApplicationId,
    parseDiscordChannelId,
    parseDiscordGuildId,
    parseDiscordUserId,
  ])("rejects an untrusted non-snowflake value", (parse) => {
    expect(parse("owner-name")).toEqual({
      ok: false,
      reason: "invalid-discord-id",
    });
    expect(parse(null)).toEqual({
      ok: false,
      reason: "invalid-discord-id",
    });
  });
});
