import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseDiscordChannelId,
  parseDiscordGuildId,
  type Result,
} from "@coloop/core";
import {
  createDiscordProvider,
  discordFinalizeCommand,
  mapDiscordFinalizeInteraction,
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

describe("Discord /finalize adapter", () => {
  test("maps an exact-guild and exact-thread Owner command with the visible proposal", () => {
    expect(discordFinalizeCommand).toEqual({
      name: "finalize",
      description: "Finalize the current Outcome Proposal",
      type: 1,
    });
    expect(
      mapDiscordFinalizeInteraction(
        {
          id: "500000000000000005",
          type: 2,
          guild_id: "200000000000000002",
          channel_id: "300000000000000003",
          member: {
            user: { id: "100000000000000001", bot: false },
          },
          data: { name: "finalize", type: 1 },
        },
        {
          guildId: "200000000000000002",
          threadId: "300000000000000003",
          proposal: {
            revisionId: "proposal-revision-1",
            resultMarkdown: "Use a canary rollout.",
            unresolvedPoints: ["Confirm the rollback owner."],
          },
        },
      ),
    ).toEqual({
      ok: true,
      value: {
        interactionId: "500000000000000005",
        guildId: "200000000000000002",
        threadId: "300000000000000003",
        actorKind: "human",
        actorDiscordUserId: "100000000000000001",
        revisionId: "proposal-revision-1",
        proposal: {
          resultMarkdown: "Use a canary rollout.",
          unresolvedPoints: ["Confirm the rollback owner."],
        },
      },
    });
  });

  test("rejects other commands, scopes, and non-human actors", () => {
    const finalize = {
      id: "500000000000000005",
      type: 2,
      guild_id: "200000000000000002",
      channel_id: "300000000000000003",
      member: { user: { id: "100000000000000001", bot: false } },
      data: { name: "finalize", type: 1 },
    };
    const context = {
      guildId: "200000000000000002",
      threadId: "300000000000000003",
      proposal: {
        revisionId: "proposal-revision-1",
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: [] as string[],
      },
    };

    expect(
      mapDiscordFinalizeInteraction(
        { ...finalize, data: { name: "other", type: 1 } },
        context,
      ),
    ).toEqual({ ok: false, reason: "unsupported-interaction" });
    expect(
      mapDiscordFinalizeInteraction(
        { ...finalize, channel_id: "400000000000000004" },
        context,
      ),
    ).toEqual({ ok: false, reason: "wrong-scope" });
    expect(
      mapDiscordFinalizeInteraction(
        {
          ...finalize,
          member: { user: { id: "100000000000000001", bot: true } },
        },
        context,
      ),
    ).toEqual({ ok: false, reason: "unsupported-actor" });
  });
});
