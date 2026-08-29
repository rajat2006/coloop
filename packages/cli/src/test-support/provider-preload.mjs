import { readFileSync } from "node:fs";

const fixture = JSON.parse(
  readFileSync(process.env.COLOOP_TEST_PROVIDER_FIXTURE, "utf8"),
);

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

const discordAuthorized = (options) =>
  new Headers(options?.headers).get("authorization") ===
  `Bot ${fixture.discordToken}`;

globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.openai.com") {
    const authorized =
      new Headers(options?.headers).get("authorization") ===
      `Bearer ${fixture.openaiApiKey}`;
    return json({}, authorized ? (fixture.openaiStatus ?? 200) : 401);
  }
  if (url.origin !== "https://discord.com") {
    throw new Error("unexpected_test_request");
  }
  if (!discordAuthorized(options)) return json({}, 401);
  if (fixture.discordStatus) return json({}, fixture.discordStatus);

  if (url.pathname.endsWith("/oauth2/applications/@me")) {
    return json({
      bot: { id: fixture.botId },
      flags: fixture.messageContentIntentEnabled === false ? 0 : 1 << 18,
      id: fixture.applicationId,
      name: "Coloop Black Box",
    });
  }
  if (url.pathname.endsWith("/users/@me/guilds")) {
    return json(
      fixture.guilds ?? [{ id: fixture.guildId, name: "Black Box Guild" }],
    );
  }
  if (url.pathname.endsWith(`/guilds/${fixture.guildId}/roles`)) {
    return json([
      { id: fixture.guildId, permissions: fixture.permissions },
    ]);
  }
  if (url.pathname.endsWith(`/guilds/${fixture.guildId}/channels`)) {
    return json([
      {
        id: fixture.channelId,
        name: "collaboration",
        permission_overwrites: [],
        type: 0,
      },
    ]);
  }
  if (url.pathname.endsWith(`/guilds/${fixture.guildId}/members/${fixture.botId}`)) {
    return json({ roles: [], user: { id: fixture.botId, username: "coloop" } });
  }
  if (url.pathname.endsWith(`/guilds/${fixture.guildId}/members/${fixture.ownerId}`)) {
    if (fixture.ownerStatus) return json({}, fixture.ownerStatus);
    return fixture.ownerResolves === false
      ? json({}, 404)
      : json({
          nick: "Owner Example",
          roles: [],
          user: { id: fixture.ownerId, username: "owner" },
        });
  }
  if (url.pathname.endsWith("/gateway/bot")) {
    return json({ url: "wss://gateway.test" });
  }
  return json({}, 404);
};

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;

  readyState = TestWebSocket.CONNECTING;
  listeners = new Map();

  constructor() {
    queueMicrotask(() => {
      this.readyState = TestWebSocket.OPEN;
      this.emit("message", {
        data: JSON.stringify({ d: { heartbeat_interval: 60_000 }, op: 10 }),
      });
    });
  }

  addEventListener(name, listener, options) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push({ listener, once: options?.once === true });
    this.listeners.set(name, listeners);
  }

  emit(name, event = {}) {
    const listeners = this.listeners.get(name) ?? [];
    this.listeners.set(
      name,
      listeners.filter(({ once }) => !once),
    );
    for (const { listener } of listeners) listener(event);
  }

  send(body) {
    const payload = JSON.parse(body);
    if (payload.op === 2) {
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({ d: {}, op: 0, t: "READY" }),
        }),
      );
    }
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

globalThis.WebSocket = TestWebSocket;
