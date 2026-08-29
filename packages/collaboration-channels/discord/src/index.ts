import { CredentialRejectedError } from "@coloop/core";

const discordApi = "https://discord.com/api/v10";
const messageContentApprovedFlag = 1 << 18;
const messageContentLimitedFlag = 1 << 19;
const gatewayIntents = (1 << 0) | (1 << 9) | (1 << 15);

export interface DiscordApplication {
  id: string;
  messageContentIntentEnabled: boolean;
  name: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  guildId: string;
  id: string;
  name: string;
  permissions: string;
  type: "GUILD_TEXT" | "OTHER";
}

export interface DiscordMember {
  displayName: string;
  id: string;
  username: string;
}

export interface DiscordProvider {
  connectGateway(token: string): Promise<{ close(): Promise<void> }>;
  getApplication(token: string): Promise<DiscordApplication>;
  listChannels(token: string, guildId: string): Promise<DiscordChannel[]>;
  listGuilds(token: string): Promise<DiscordGuild[]>;
  resolveMember(
    token: string,
    guildId: string,
    userId: string,
  ): Promise<DiscordMember | null>;
}

export const requiredDiscordPermissions =
  (1n << 10n) |
  (1n << 11n) |
  (1n << 16n) |
  (1n << 31n) |
  (1n << 36n) |
  (1n << 38n);

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
  if (permissions !== requiredDiscordPermissions) {
    throw new Error(
      "Permission check failed: remove every permission outside the required least-privilege set.",
    );
  }
};

export const verifyChannelIsolation = (
  channels: DiscordChannel[],
  parentChannel: DiscordChannel,
): void => {
  for (const channel of channels) {
    if (channel.id === parentChannel.id) continue;
    let permissions: bigint;
    try {
      permissions = BigInt(channel.permissions);
    } catch {
      throw new Error("Discord returned an invalid permission set.");
    }
    if ((permissions & (1n << 10n)) !== 0n) {
      throw new Error(
        `Permission check failed: deny the dedicated Discord application access to every channel except #${parentChannel.name}.`,
      );
    }
  }
};

interface DiscordApplicationResponse {
  bot?: { id?: unknown };
  flags?: unknown;
  id?: unknown;
  name?: unknown;
}

interface DiscordGuildResponse {
  id?: unknown;
  name?: unknown;
}

interface DiscordRoleResponse {
  id?: unknown;
  permissions?: unknown;
}

interface DiscordMemberResponse {
  nick?: unknown;
  roles?: unknown;
  user?: {
    global_name?: unknown;
    id?: unknown;
    username?: unknown;
  };
}

interface DiscordOverwriteResponse {
  allow?: unknown;
  deny?: unknown;
  id?: unknown;
  type?: unknown;
}

interface DiscordChannelResponse {
  id?: unknown;
  name?: unknown;
  permission_overwrites?: unknown;
  type?: unknown;
}

class ProviderResourceNotFoundError extends Error {}

const readJson = async <T>(response: Response): Promise<T> => {
  if (response.status === 401) {
    throw new CredentialRejectedError();
  }
  if (response.status === 404) {
    throw new ProviderResourceNotFoundError();
  }
  if (!response.ok) {
    throw new Error("provider_request_failed");
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("provider_response_invalid");
  }
};

const discordRequest = async <T>(path: string, token: string): Promise<T> =>
  await readJson<T>(
    await fetch(`${discordApi}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15_000),
    }),
  );

const requireString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("provider_response_invalid");
  }
  return value;
};

const parseApplication = (
  response: DiscordApplicationResponse,
): DiscordApplication => {
  const flags = typeof response.flags === "number" ? response.flags : 0;
  return {
    id: requireString(response.id),
    messageContentIntentEnabled:
      (flags & messageContentApprovedFlag) !== 0 ||
      (flags & messageContentLimitedFlag) !== 0,
    name: requireString(response.name),
  };
};

const applyOverwrite = (
  permissions: bigint,
  overwrite: DiscordOverwriteResponse,
): bigint => {
  const denied = BigInt(requireString(overwrite.deny));
  const allowed = BigInt(requireString(overwrite.allow));
  return (permissions & ~denied) | allowed;
};

const calculateChannelPermissions = (
  guildId: string,
  botId: string,
  memberRoleIds: string[],
  roles: DiscordRoleResponse[],
  overwrites: DiscordOverwriteResponse[],
): string => {
  const everyone = roles.find((role) => role.id === guildId);
  if (!everyone) {
    throw new Error("provider_response_invalid");
  }
  let permissions = BigInt(requireString(everyone.permissions));
  for (const role of roles) {
    if (memberRoleIds.includes(requireString(role.id))) {
      permissions |= BigInt(requireString(role.permissions));
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
    if (
      overwrite.type === 0 &&
      memberRoleIds.includes(requireString(overwrite.id))
    ) {
      roleDenied |= BigInt(requireString(overwrite.deny));
      roleAllowed |= BigInt(requireString(overwrite.allow));
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
  const gateway = await discordRequest<{ url?: unknown }>("/gateway/bot", token);
  const gatewayUrl = requireString(gateway.url);
  const socket = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);
  let heartbeat: NodeJS.Timeout | undefined;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("gateway_timeout"));
    }, 15_000);
    const fail = (): void => {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      reject(new Error("gateway_failed"));
    };
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener("close", fail, { once: true });
    socket.addEventListener("message", (event) => {
      let payload: { d?: unknown; op?: unknown; t?: unknown };
      try {
        payload = JSON.parse(String(event.data)) as typeof payload;
      } catch {
        fail();
        return;
      }
      if (payload.op === 10) {
        const hello = payload.d as { heartbeat_interval?: unknown };
        if (typeof hello.heartbeat_interval !== "number") {
          fail();
          return;
        }
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ d: null, op: 1 }));
          }
        }, hello.heartbeat_interval);
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
  connectGateway: connectDiscordGateway,
  async getApplication(token) {
    return parseApplication(
      await discordRequest<DiscordApplicationResponse>(
        "/oauth2/applications/@me",
        token,
      ),
    );
  },
  async listChannels(token, guildId) {
    const application = await discordRequest<DiscordApplicationResponse>(
      "/oauth2/applications/@me",
      token,
    );
    const botId = requireString(application.bot?.id);
    const [member, roles, channels] = await Promise.all([
      discordRequest<DiscordMemberResponse>(
        `/guilds/${guildId}/members/${botId}`,
        token,
      ),
      discordRequest<DiscordRoleResponse[]>(`/guilds/${guildId}/roles`, token),
      discordRequest<DiscordChannelResponse[]>(
        `/guilds/${guildId}/channels`,
        token,
      ),
    ]);
    const memberRoleIds = Array.isArray(member.roles)
      ? member.roles.map(requireString)
      : [];
    return channels.map<DiscordChannel>((channel) => {
      const overwrites = Array.isArray(channel.permission_overwrites)
        ? (channel.permission_overwrites as DiscordOverwriteResponse[])
        : [];
      return {
        guildId,
        id: requireString(channel.id),
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
  },
  async listGuilds(token) {
    const guilds = await discordRequest<DiscordGuildResponse[]>(
      "/users/@me/guilds",
      token,
    );
    return guilds.map<DiscordGuild>((guild) => ({
      id: requireString(guild.id),
      name: requireString(guild.name),
    }));
  },
  async resolveMember(token, guildId, userId) {
    try {
      const member = await discordRequest<DiscordMemberResponse>(
        `/guilds/${guildId}/members/${userId}`,
        token,
      );
      const id = requireString(member.user?.id);
      const username = requireString(member.user?.username);
      const preferredName =
        typeof member.nick === "string"
          ? member.nick
          : typeof member.user?.global_name === "string"
            ? member.user.global_name
            : username;
      return {
        displayName: preferredName,
        id,
        username,
      } satisfies DiscordMember;
    } catch (error) {
      if (error instanceof ProviderResourceNotFoundError) return null;
      throw error;
    }
  },
});
