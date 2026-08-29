import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseDiscordChannelId,
  parseDiscordGuildId,
  type Result,
} from "@coloop/core";
import {
  createDiscordProvider,
  requiredDiscordPermissions,
  verifyChannelIsolation,
  verifyPermissions,
  type DiscordChannel,
} from "./index.js";

const valueOf = <Value>(
  result: Result<Value, "invalid-discord-id">,
): Value => {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
};

const guildId = valueOf(parseDiscordGuildId("200000000000000002"));

const channel = (
  id: string,
  permissions = requiredDiscordPermissions.toString(),
): DiscordChannel => ({
  guildId,
  id: valueOf(parseDiscordChannelId(id)),
  name: `channel-${id.at(-1)}`,
  permissions,
  type: "GUILD_TEXT",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Discord permission policy", () => {
  test("accepts only the exact least-privilege permission set", () => {
    expect(verifyPermissions(channel("300000000000000003"))).toEqual({
      ok: true,
    });
    expect(
      verifyPermissions(
        channel(
          "300000000000000003",
          (requiredDiscordPermissions | (1n << 3n)).toString(),
        ),
      ),
    ).toMatchObject({ ok: false, reason: "administrator-not-allowed" });
    expect(
      verifyPermissions(channel("300000000000000003", "1024")),
    ).toMatchObject({ ok: false, reason: "missing-permissions" });
  });

  test("rejects visibility outside the selected parent channel", () => {
    const parent = channel("300000000000000003");
    const unrelated = channel("400000000000000004", "1024");

    expect(verifyChannelIsolation([parent, unrelated], parent)).toMatchObject({
      ok: false,
      reason: "channel-access-not-isolated",
    });
  });
});

describe("Discord provider payload validation", () => {
  test("returns a rejected-credential result for HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(
      createDiscordProvider().getApplication("bad-token"),
    ).resolves.toEqual({ ok: false, reason: "credential-rejected" });
  });

  test("rejects malformed successful payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "not-a-snowflake", name: "Coloop" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );

    await expect(
      createDiscordProvider().getApplication("token"),
    ).resolves.toEqual({ ok: false, reason: "invalid-response" });
  });
});
