import { describe, expect, test } from "vitest";
import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
} from "../discord-ids.js";
import type { Result } from "../result.js";
import {
  requireReadyInstallation,
  type InstallationConfig,
} from "./installation-config.js";

const valueOf = <Value>(
  result: Result<Value, "invalid-discord-id">,
): Value => {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
};

describe("installation readiness", () => {
  test("returns a configuration only when every required identity is present", () => {
    const config: InstallationConfig = {
      discordApplicationId: valueOf(
        parseDiscordApplicationId("100000000000000001"),
      ),
      guildId: valueOf(parseDiscordGuildId("200000000000000002")),
      ownerUserId: valueOf(parseDiscordUserId("300000000000000003")),
      parentChannelId: valueOf(parseDiscordChannelId("400000000000000004")),
      schemaVersion: 1,
    };

    expect(requireReadyInstallation(config)).toEqual({
      ok: true,
      value: config,
    });
  });

  test("rejects an incomplete configuration", () => {
    expect(requireReadyInstallation({ schemaVersion: 1 })).toEqual({
      ok: false,
      reason: "installation-incomplete",
    });
  });
});
