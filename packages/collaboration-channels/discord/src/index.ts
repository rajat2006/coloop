import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
  type DiscordApplicationId,
  type DiscordChannelId,
  type DiscordGuildId,
  type DiscordUserId,
  type Result,
} from "@coloop/core";

const discordApi = "https://discord.com/api/v10";
const messageContentApprovedFlag = 1 << 18;
const messageContentLimitedFlag = 1 << 19;
const gatewayIntents = (1 << 0) | (1 << 9) | (1 << 15);

export interface DiscordApplication {
  id: DiscordApplicationId;
  messageContentIntentEnabled: boolean;
  name: string;
}

export interface DiscordGuild {
  id: DiscordGuildId;
  name: string;
}

export interface DiscordChannel {
  guildId: DiscordGuildId;
  id: DiscordChannelId;
  name: string;
  permissions: string;
  type: "GUILD_TEXT" | "OTHER";
}

export interface DiscordMember {
  displayName: string;
  id: DiscordUserId;
  username: string;
}

export const discordFinalizeCommand = {
  name: "finalize",
  description: "Finalize the current Outcome Proposal",
  type: 1,
} as const;

export interface DiscordVisibleOutcomeProposal {
  readonly revisionId: string;
  readonly resultMarkdown: string;
  readonly unresolvedPoints: readonly string[];
}

export interface DiscordFinalizationInteraction {
  readonly interactionId: string;
  readonly guildId: string;
  readonly threadId: string;
  readonly actorKind: "human";
  readonly actorDiscordUserId: string;
  readonly revisionId: string;
  readonly proposal: {
    readonly resultMarkdown: string;
    readonly unresolvedPoints: readonly string[];
  };
}

export type DiscordFinalizationMappingResult = Result<
  DiscordFinalizationInteraction,
  "invalid-proposal" | "unsupported-actor" | "unsupported-interaction" | "wrong-scope"
>;

export function mapDiscordFinalizeInteraction(
  value: unknown,
  context: {
    readonly guildId: string;
    readonly threadId: string;
    readonly proposal: DiscordVisibleOutcomeProposal;
  },
): DiscordFinalizationMappingResult {
  if (!isRecord(value) || value.type !== 2 || !isRecord(value.data)) {
    return { ok: false, reason: "unsupported-interaction" };
  }
  if (
    value.data.name !== discordFinalizeCommand.name ||
    value.data.type !== discordFinalizeCommand.type
  ) {
    return { ok: false, reason: "unsupported-interaction" };
  }
  const guildId = parseDiscordGuildId(value.guild_id);
  const threadId = parseDiscordChannelId(value.channel_id);
  if (
    !guildId.ok ||
    !threadId.ok ||
    guildId.value !== context.guildId ||
    threadId.value !== context.threadId
  ) {
    return { ok: false, reason: "wrong-scope" };
  }
  if (!isRecord(value.member) || !isRecord(value.member.user)) {
    return { ok: false, reason: "unsupported-actor" };
  }
  const actorDiscordUserId = parseDiscordUserId(value.member.user.id);
  if (!actorDiscordUserId.ok || value.member.user.bot !== false) {
    return { ok: false, reason: "unsupported-actor" };
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof context.proposal.revisionId !== "string" ||
    context.proposal.revisionId.length === 0 ||
    typeof context.proposal.resultMarkdown !== "string" ||
    context.proposal.resultMarkdown.length === 0 ||
    !Array.isArray(context.proposal.unresolvedPoints) ||
    !context.proposal.unresolvedPoints.every(
      (point) => typeof point === "string" && point.length > 0,
    )
  ) {
    return { ok: false, reason: "invalid-proposal" };
  }
  return {
    ok: true,
    value: {
      interactionId: value.id,
      guildId: guildId.value,
      threadId: threadId.value,
      actorKind: "human",
      actorDiscordUserId: actorDiscordUserId.value,
      revisionId: context.proposal.revisionId,
      proposal: {
        resultMarkdown: context.proposal.resultMarkdown,
        unresolvedPoints: context.proposal.unresolvedPoints,
      },
    },
  };
}

export type DiscordProviderFailureReason =
  | "credential-rejected"
  | "invalid-response"
  | "provider-unavailable"
  | "resource-not-found";

export type DiscordProviderResult<Value> = Result<
  Value,
  DiscordProviderFailureReason
>;

export interface DiscordProvider {
  connectGateway(
    token: string,
  ): Promise<DiscordProviderResult<{ close(): Promise<void> }>>;
  getApplication(
    token: string,
  ): Promise<DiscordProviderResult<DiscordApplication>>;
  listChannels(
    token: string,
    guildId: DiscordGuildId,
  ): Promise<DiscordProviderResult<DiscordChannel[]>>;
  listGuilds(token: string): Promise<DiscordProviderResult<DiscordGuild[]>>;
  resolveMember(
    token: string,
    guildId: DiscordGuildId,
    userId: DiscordUserId,
  ): Promise<DiscordProviderResult<DiscordMember>>;
}

export const requiredDiscordPermissions =
  (1n << 10n) |
  (1n << 11n) |
  (1n << 16n) |
  (1n << 31n) |
  (1n << 36n) |
  (1n << 38n);

export type DiscordPermissionFailureReason =
  | "administrator-not-allowed"
  | "channel-access-not-isolated"
  | "extra-permissions"
  | "invalid-permissions"
  | "missing-permissions";

export type DiscordPermissionResult =
  | { readonly ok: true }
  | {
      readonly message: string;
      readonly ok: false;
      readonly reason: DiscordPermissionFailureReason;
    };

export const verifyPermissions = (
  channel: DiscordChannel,
): DiscordPermissionResult => {
  // The dedicated application must have exactly this set: no Administrator and no extras.
  let permissions: bigint;
  try {
    permissions = BigInt(channel.permissions);
  } catch {
    return {
      message: "Discord returned an invalid permission set.",
      ok: false,
      reason: "invalid-permissions",
    };
  }
  if ((permissions & (1n << 3n)) !== 0n) {
    return {
      message:
        "Permission check failed: remove Administrator from the dedicated Discord application.",
      ok: false,
      reason: "administrator-not-allowed",
    };
  }
  if ((permissions & requiredDiscordPermissions) !== requiredDiscordPermissions) {
    return {
      message:
        "Permission check failed: View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Read Message History, and Use Application Commands are required.",
      ok: false,
      reason: "missing-permissions",
    };
  }
  if (permissions !== requiredDiscordPermissions) {
    return {
      message:
        "Permission check failed: remove every permission outside the required least-privilege set.",
      ok: false,
      reason: "extra-permissions",
    };
  }
  return { ok: true };
};

export const verifyChannelIsolation = (
  channels: DiscordChannel[],
  parentChannel: DiscordChannel,
): DiscordPermissionResult => {
  // The selected parent is the only channel the dedicated application may view.
  for (const channel of channels) {
    if (channel.id === parentChannel.id) continue;
    let permissions: bigint;
    try {
      permissions = BigInt(channel.permissions);
    } catch {
      return {
        message: "Discord returned an invalid permission set.",
        ok: false,
        reason: "invalid-permissions",
      };
    }
    if ((permissions & (1n << 10n)) !== 0n) {
      return {
        message: `Permission check failed: deny the dedicated Discord application access to every channel except #${parentChannel.name}.`,
        ok: false,
        reason: "channel-access-not-isolated",
      };
    }
  }
  return { ok: true };
};

class DiscordRequestError extends Error {
  constructor(readonly reason: DiscordProviderFailureReason) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new DiscordRequestError("invalid-response");
  }
  return value;
};

const requireArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new DiscordRequestError("invalid-response");
  }
  return value;
};

const requireString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DiscordRequestError("invalid-response");
  }
  return value;
};

const requireNumber = (value: unknown): number => {
  if (typeof value !== "number") {
    throw new DiscordRequestError("invalid-response");
  }
  return value;
};

const requireApplicationId = (value: unknown): DiscordApplicationId => {
  const result = parseDiscordApplicationId(value);
  if (!result.ok) throw new DiscordRequestError("invalid-response");
  return result.value;
};

const requireChannelId = (value: unknown): DiscordChannelId => {
  const result = parseDiscordChannelId(value);
  if (!result.ok) throw new DiscordRequestError("invalid-response");
  return result.value;
};

const requireGuildId = (value: unknown): DiscordGuildId => {
  const result = parseDiscordGuildId(value);
  if (!result.ok) throw new DiscordRequestError("invalid-response");
  return result.value;
};

const requireUserId = (value: unknown): DiscordUserId => {
  const result = parseDiscordUserId(value);
  if (!result.ok) throw new DiscordRequestError("invalid-response");
  return result.value;
};

const readJson = async (response: Response): Promise<unknown> => {
  if (response.status === 401) {
    throw new DiscordRequestError("credential-rejected");
  }
  if (response.status === 404) {
    throw new DiscordRequestError("resource-not-found");
  }
  if (!response.ok) {
    throw new DiscordRequestError("provider-unavailable");
  }
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    throw new DiscordRequestError("invalid-response");
  }
};

const discordRequest = async (path: string, token: string): Promise<unknown> =>
  await readJson(
    await fetch(`${discordApi}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15_000),
    }),
  );

const attempt = async <Value>(
  operation: () => Promise<Value>,
): Promise<DiscordProviderResult<Value>> => {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof DiscordRequestError
          ? error.reason
          : "provider-unavailable",
    };
  }
};

const parseApplication = (value: unknown): DiscordApplication => {
  const response = requireRecord(value);
  const flags = response.flags === undefined ? 0 : requireNumber(response.flags);
  return {
    id: requireApplicationId(response.id),
    messageContentIntentEnabled:
      (flags & messageContentApprovedFlag) !== 0 ||
      (flags & messageContentLimitedFlag) !== 0,
    name: requireString(response.name),
  };
};

interface DiscordRole {
  id: string;
  permissions: string;
}

interface DiscordOverwrite {
  allow: string;
  deny: string;
  id: string;
  type: number;
}

const parseRole = (value: unknown): DiscordRole => {
  const role = requireRecord(value);
  return {
    id: requireString(role.id),
    permissions: requireString(role.permissions),
  };
};

const parseOverwrite = (value: unknown): DiscordOverwrite => {
  const overwrite = requireRecord(value);
  return {
    allow: requireString(overwrite.allow),
    deny: requireString(overwrite.deny),
    id: requireString(overwrite.id),
    type: requireNumber(overwrite.type),
  };
};

const applyOverwrite = (
  permissions: bigint,
  overwrite: DiscordOverwrite,
): bigint => {
  const denied = BigInt(overwrite.deny);
  const allowed = BigInt(overwrite.allow);
  return (permissions & ~denied) | allowed;
};

const calculateChannelPermissions = (
  guildId: DiscordGuildId,
  botId: DiscordUserId,
  memberRoleIds: string[],
  roles: DiscordRole[],
  overwrites: DiscordOverwrite[],
): string => {
  // Discord resolves base roles, everyone overwrite, role overwrites, then member overwrite.
  const everyone = roles.find((role) => role.id === guildId);
  if (!everyone) {
    throw new DiscordRequestError("invalid-response");
  }
  let permissions = BigInt(everyone.permissions);
  for (const role of roles) {
    if (memberRoleIds.includes(role.id)) {
      permissions |= BigInt(role.permissions);
    }
  }
  if ((permissions & (1n << 3n)) !== 0n) {
    return permissions.toString();
  }

  const everyoneOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
  );
  if (everyoneOverwrite) {
    permissions = applyOverwrite(permissions, everyoneOverwrite);
  }

  let roleDenied = 0n;
  let roleAllowed = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && memberRoleIds.includes(overwrite.id)) {
      roleDenied |= BigInt(overwrite.deny);
      roleAllowed |= BigInt(overwrite.allow);
    }
  }
  permissions = (permissions & ~roleDenied) | roleAllowed;

  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === botId,
  );
  if (memberOverwrite) {
    permissions = applyOverwrite(permissions, memberOverwrite);
  }
  return permissions.toString();
};

const connectDiscordGateway = async (
  token: string,
): Promise<{ close(): Promise<void> }> => {
  const gateway = requireRecord(await discordRequest("/gateway/bot", token));
  const gatewayUrl = requireString(gateway.url);
  const socket = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);
  let heartbeat: NodeJS.Timeout | undefined;

  // Resolve only after READY so callers never receive a half-initialized connection.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new DiscordRequestError("provider-unavailable"));
    }, 15_000);
    const fail = (): void => {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      reject(new DiscordRequestError("provider-unavailable"));
    };
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener("close", fail, { once: true });
    socket.addEventListener("message", (event) => {
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        payload = requireRecord(parsed);
      } catch {
        fail();
        return;
      }
      if (payload.op === 10) {
        let heartbeatInterval: number;
        try {
          heartbeatInterval = requireNumber(
            requireRecord(payload.d).heartbeat_interval,
          );
        } catch {
          fail();
          return;
        }
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ d: null, op: 1 }));
          }
        }, heartbeatInterval);
        socket.send(
          JSON.stringify({
            d: {
              intents: gatewayIntents,
              properties: {
                browser: "coloop",
                device: "coloop",
                os: process.platform,
              },
              token,
            },
            op: 2,
          }),
        );
      }
      if (payload.op === 0 && payload.t === "READY") {
        clearTimeout(timeout);
        resolve();
      }
      if (payload.op === 9) {
        fail();
      }
    });
  });

  return {
    close: async () => {
      if (heartbeat) clearInterval(heartbeat);
      if (
        socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN
      ) {
        socket.close(1000, "Coloop stopped");
      }
    },
  };
};

export const createDiscordProvider = (): DiscordProvider => ({
  async connectGateway(token) {
    return await attempt(async () => await connectDiscordGateway(token));
  },
  async getApplication(token) {
    return await attempt(async () =>
      parseApplication(await discordRequest("/oauth2/applications/@me", token)),
    );
  },
  async listChannels(token, guildId) {
    return await attempt(async () => {
      const application = requireRecord(
        await discordRequest("/oauth2/applications/@me", token),
      );
      const bot = requireRecord(application.bot);
      const botId = requireUserId(bot.id);
      const [memberValue, rolesValue, channelsValue] = await Promise.all([
        discordRequest(`/guilds/${guildId}/members/${botId}`, token),
        discordRequest(`/guilds/${guildId}/roles`, token),
        discordRequest(`/guilds/${guildId}/channels`, token),
      ]);
      const member = requireRecord(memberValue);
      const memberRoleIds = requireArray(member.roles).map(requireString);
      const roles = requireArray(rolesValue).map(parseRole);
      return requireArray(channelsValue).map<DiscordChannel>((value) => {
        const channel = requireRecord(value);
        const overwrites =
          channel.permission_overwrites === undefined
            ? []
            : requireArray(channel.permission_overwrites).map(parseOverwrite);
        return {
          guildId,
          id: requireChannelId(channel.id),
          name: requireString(channel.name),
          permissions: calculateChannelPermissions(
            guildId,
            botId,
            memberRoleIds,
            roles,
            overwrites,
          ),
          type: channel.type === 0 ? "GUILD_TEXT" : "OTHER",
        };
      });
    });
  },
  async listGuilds(token) {
    return await attempt(async () =>
      requireArray(await discordRequest("/users/@me/guilds", token)).map(
        (value): DiscordGuild => {
          const guild = requireRecord(value);
          return {
            id: requireGuildId(guild.id),
            name: requireString(guild.name),
          };
        },
      ),
    );
  },
  async resolveMember(token, guildId, userId) {
    return await attempt(async () => {
      const member = requireRecord(
        await discordRequest(`/guilds/${guildId}/members/${userId}`, token),
      );
      const user = requireRecord(member.user);
      const id = requireUserId(user.id);
      const username = requireString(user.username);
      const preferredName =
        typeof member.nick === "string"
          ? member.nick
          : typeof user.global_name === "string"
            ? user.global_name
            : username;
      return { displayName: preferredName, id, username };
    });
  },
});
