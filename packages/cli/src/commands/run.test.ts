import { Readable, Writable } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandResult } from "@coloop/coding-agent-codex";
import {
  parseDiscordChannelId,
  parseDiscordGuildId,
  type Result,
} from "@coloop/core";
import type { ColoopDependencies } from "../dependencies.js";
import { checkReadiness } from "../readiness.js";
import { Terminal } from "../terminal/terminal.js";
import { runRuntime } from "./run.js";

vi.mock("../readiness.js", () => ({ checkReadiness: vi.fn() }));

const valueOf = <Value>(
  result: Result<Value, "invalid-discord-id">,
): Value => {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
};

class StringWriter extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

const unavailable = async (): Promise<{
  readonly ok: false;
  readonly reason: "provider-unavailable";
}> => ({ ok: false, reason: "provider-unavailable" });

const commandFailure = async (): Promise<CommandResult> => ({
  exitCode: 1,
  ok: false,
  reason: "command-failed",
  stderr: "",
  stdout: "",
});

const createDependencies = (
  connectGateway: ColoopDependencies["discord"]["connectGateway"],
): ColoopDependencies => ({
  coloopEntrypoint: { args: [], command: "coloop" },
  discord: {
    connectGateway,
    getApplication: unavailable,
    listChannels: unavailable,
    listGuilds: unavailable,
    resolveMember: unavailable,
  },
  openExternal: async () => {},
  openai: { validateCredential: unavailable },
  runCodex: commandFailure,
  runColoop: commandFailure,
  waitForShutdown: async () => {},
});

beforeEach(() => {
  vi.mocked(checkReadiness).mockReset();
});

describe("foreground runtime command", () => {
  test("opens and closes the Gateway after readiness passes", async () => {
    const output = new StringWriter();
    const close = vi.fn(async () => {});
    const connect: ColoopDependencies["discord"]["connectGateway"] =
      async () => ({ ok: true, value: { close } });
    const connectGateway = vi.fn(connect);
    vi.mocked(checkReadiness).mockResolvedValue({
      ok: true,
      value: {
        channel: {
          guildId: valueOf(parseDiscordGuildId("200000000000000002")),
          id: valueOf(parseDiscordChannelId("300000000000000003")),
          name: "collaboration",
          permissions: "345744935936",
          type: "GUILD_TEXT",
        },
        discordToken: "discord-secret",
        guild: {
          id: valueOf(parseDiscordGuildId("200000000000000002")),
          name: "Test Guild",
        },
      },
    });

    await runRuntime(
      createDependencies(connectGateway),
      new Terminal(Readable.from([]), output),
      {},
    );

    expect(connectGateway).toHaveBeenCalledWith("discord-secret");
    expect(close).toHaveBeenCalledOnce();
    expect(output.value).toContain("Readiness check passed.");
    expect(output.value).toContain(
      "Coloop is running in the foreground for Test Guild/#collaboration.",
    );
  });

  test("does not open the Gateway when readiness fails", async () => {
    const connectGateway = vi.fn(unavailable);
    vi.mocked(checkReadiness).mockResolvedValue({
      message: "OPENAI_API_KEY is required to start Coloop.",
      ok: false,
      reason: "openai-credential-missing",
    });

    await expect(
      runRuntime(
        createDependencies(connectGateway),
        new Terminal(Readable.from([]), new StringWriter()),
        {},
      ),
    ).rejects.toThrow("OPENAI_API_KEY is required to start Coloop.");
    expect(connectGateway).not.toHaveBeenCalled();
  });
});
