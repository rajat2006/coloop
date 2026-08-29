import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import type { CommandResult } from "@coloop/coding-agent-codex";
import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
  type DiscordGuildId,
  type Result,
} from "@coloop/core";
import type {
  DiscordApplication,
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
} from "@coloop/discord";
import type { ColoopDependencies } from "../dependencies.js";
import { runCli as runCliApplication } from "../run-cli.js";

const valueOf = <Value>(
  result: Result<Value, "invalid-discord-id">,
): Value => {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
};

const applicationId = valueOf(
  parseDiscordApplicationId("100000000000000001"),
);
const guildId = valueOf(parseDiscordGuildId("200000000000000002"));
const channelId = valueOf(parseDiscordChannelId("300000000000000003"));
const ownerId = valueOf(parseDiscordUserId("123456789012345678"));
const replacementOwnerId = valueOf(
  parseDiscordUserId("987654321098765432"),
);

const readyFixture: Fixture = {
  discord: {
    expectedCredential: "discord-test-secret",
    credentialValid: true,
    providerUnavailable: false,
    application: {
      id: applicationId,
      name: "Coloop Test",
      messageContentIntentEnabled: true,
    },
    guilds: [{ id: guildId, name: "Test Guild" }],
    channels: [
      {
        id: channelId,
        guildId,
        name: "collaboration",
        type: "GUILD_TEXT",
        permissions: "345744935936",
      },
    ],
    members: [
      {
        guildId,
        id: ownerId,
        username: "owner",
        displayName: "Owner Example",
      },
    ],
  },
  openai: {
    expectedCredential: "openai-test-secret",
    credentialValid: true,
    providerUnavailable: false,
  },
  codex: {
    version: "codex-cli 0.150.1",
  },
};

interface CliResult {
  code: number;
  codexRepairs: number;
  mcpInstalled: boolean;
  openedUrls: string[];
  root: string;
  runtimeStarts: number;
  stderr: string;
  stdout: string;
}

interface Fixture {
  codex: { version: string };
  discord: {
    application: DiscordApplication;
    channels: DiscordChannel[];
    credentialValid: boolean;
    expectedCredential: string;
    guilds: DiscordGuild[];
    members: Array<DiscordMember & { guildId: DiscordGuildId }>;
    providerUnavailable?: boolean;
  };
  openai: {
    credentialValid: boolean;
    expectedCredential: string;
    providerUnavailable?: boolean;
  };
}

interface InstallationTestState {
  codexRepairs: number;
  mcpCommandValid: boolean;
  mcpInstalled: boolean;
  runtimeStarts: number;
}

const installationStates = new Map<string, InstallationTestState>();

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

const createDependencies = (
  fixture: Fixture,
  openedUrls: string[],
  state: InstallationTestState,
): ColoopDependencies => {
  const coloopEntrypoint = {
    args: ["/test/coloop/dist/main.js"],
    command: "/test/node",
  };
  return {
    coloopEntrypoint,
    discord: {
      async connectGateway(token) {
        if (!fixture.discord.credentialValid || token !== fixture.discord.expectedCredential) {
          return { ok: false, reason: "credential-rejected" };
        }
        state.runtimeStarts += 1;
        return { ok: true, value: { close: async () => {} } };
      },
      async getApplication(token) {
        if (fixture.discord.providerUnavailable) {
          return { ok: false, reason: "provider-unavailable" };
        }
        if (!fixture.discord.credentialValid || token !== fixture.discord.expectedCredential) {
          return { ok: false, reason: "credential-rejected" };
        }
        return { ok: true, value: fixture.discord.application };
      },
      async listChannels(token, guildId) {
        if (!fixture.discord.credentialValid || token !== fixture.discord.expectedCredential) {
          return { ok: false, reason: "credential-rejected" };
        }
        return {
          ok: true,
          value: fixture.discord.channels.filter(
            (channel) => channel.guildId === guildId,
          ),
        };
      },
      async listGuilds(token) {
        if (!fixture.discord.credentialValid || token !== fixture.discord.expectedCredential) {
          return { ok: false, reason: "credential-rejected" };
        }
        return { ok: true, value: fixture.discord.guilds };
      },
      async resolveMember(token, guildId, userId) {
        if (!fixture.discord.credentialValid || token !== fixture.discord.expectedCredential) {
          return { ok: false, reason: "credential-rejected" };
        }
        const member = fixture.discord.members.find(
          (candidate) =>
            candidate.guildId === guildId && candidate.id === userId,
        );
        return member
          ? { ok: true, value: member }
          : { ok: false, reason: "resource-not-found" };
      },
    },
    openExternal: async (url) => {
      openedUrls.push(url);
    },
    openai: {
      async validateCredential(apiKey) {
        if (fixture.openai.providerUnavailable) {
          return { ok: false, reason: "provider-unavailable" };
        }
        if (!fixture.openai.credentialValid || apiKey !== fixture.openai.expectedCredential) {
          return { ok: false, reason: "credential-rejected" };
        }
        return { ok: true };
      },
    },
    runCodex: async (args): Promise<CommandResult> => {
      if (args[0] === "--version") {
        return { ok: true, stderr: "", stdout: `${fixture.codex.version}\n` };
      }
      if (args[0] === "mcp" && args[1] === "add") {
        state.mcpCommandValid = true;
        state.mcpInstalled = true;
        return { ok: true, stderr: "", stdout: "Added MCP server\n" };
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        state.codexRepairs += 1;
        state.mcpInstalled = false;
        return { ok: true, stderr: "", stdout: "Removed MCP server\n" };
      }
      if (args[0] === "mcp" && args[1] === "get") {
        return state.mcpInstalled
          ? {
              ok: true,
              stderr: "",
              stdout: JSON.stringify({
                enabled: true,
                name: "coloop",
                transport: {
                  args: [...coloopEntrypoint.args, "mcp"],
                  command: state.mcpCommandValid
                    ? coloopEntrypoint.command
                    : "legacy-coloop",
                  type: "stdio",
                },
              }),
            }
          : {
              exitCode: 1,
              ok: false,
              reason: "command-failed",
              stderr: "not found\n",
              stdout: "",
            };
      }
      return {
        exitCode: 1,
        ok: false,
        reason: "command-failed",
        stderr: "unsupported command\n",
        stdout: "",
      };
    },
    runColoop: async (args) => {
      if (args[0] !== "verify-entrypoint") {
        return {
          exitCode: 1,
          ok: false,
          reason: "command-failed",
          stderr: "unsupported command\n",
          stdout: "",
        };
      }
      return {
        ok: true,
        stderr: "",
        stdout: `${JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          result: { tools: [{ name: "open_episode" }] },
        })}\n`,
      };
    },
    waitForShutdown: async () => {},
  };
};

const runCli = async (
  args: string[],
  input: string,
  fixture: Fixture = readyFixture,
  environment: Record<string, string | undefined> = {},
  existingRoot?: string,
): Promise<CliResult> => {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), "coloop-cli-test-")));
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  const openedUrls: string[] = [];
  const state = installationStates.get(root) ?? {
    codexRepairs: 0,
    mcpCommandValid: false,
    mcpInstalled: false,
    runtimeStarts: 0,
  };
  installationStates.set(root, state);
  const code = await runCliApplication(
    args,
    createDependencies(fixture, openedUrls, state),
    {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      CODEX_HOME: join(root, "home", ".codex"),
      DISCORD_TOKEN: readyFixture.discord.expectedCredential,
      OPENAI_API_KEY: readyFixture.openai.expectedCredential,
      ...environment,
    },
    {
      error: stderr,
      input: Readable.from([input]),
      output: stdout,
    },
  );

  return {
    code,
    codexRepairs: state.codexRepairs,
    mcpInstalled: state.mcpInstalled,
    openedUrls,
    root,
    runtimeStarts: state.runtimeStarts,
    stderr: stderr.value,
    stdout: stdout.value,
  };
};

const readInstallationFiles = async (directory: string): Promise<Buffer[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Buffer[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readInstallationFiles(path)));
    } else if (entry.isFile()) {
      files.push(await readFile(path));
    }
  }
  return files;
};

describe("coloop CLI", () => {
  test("fresh setup establishes the Owner Pairing and reaches readiness", async () => {
    const result = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
    );

    expect(
      result.code,
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.openedUrls).toEqual([]);
    expect(result.stdout).toContain("Discord application: Coloop Test");
    expect(result.stdout).toContain(
      "Required intents: Guilds, Guild Messages, Message Content.",
    );
    expect(result.stdout).toContain(
      "Required permissions: View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Read Message History, Use Application Commands.",
    );
    expect(result.stdout).toContain("Server: Test Guild");
    expect(result.stdout).toContain("Parent channel: #collaboration");
    expect(result.stdout).toContain(
      `Resolved Owner: Owner Example (@owner, ${ownerId})`,
    );
    expect(result.stdout).toContain(
      "OpenAI Platform credential is separate from Codex CLI authentication",
    );
    expect(result.stdout).toContain("Ready. Run `coloop run` to start Coloop.");
    expect(result.stdout).toContain(
      "Only the supported Codex CLI is configured; IDE and desktop clients are not supported in v0.",
    );
    expect(result.mcpInstalled).toBe(true);

    const configPath = join(result.root, "config", "coloop", "config.json");
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
    expect(config).toEqual({
      schemaVersion: 1,
      discordApplicationId: "100000000000000001",
      guildId: "200000000000000002",
      ownerUserId: ownerId,
      parentChannelId: "300000000000000003",
    });

    const databasePath = join(result.root, "state", "coloop", "coloop.sqlite");
    const artifactsPath = join(result.root, "state", "coloop", "episodes");
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(artifactsPath)).mode & 0o777).toBe(0o700);
    const hooks: unknown = JSON.parse(
      await readFile(join(result.root, "home", ".codex", "hooks.json"), "utf8"),
    );
    expect(hooks).toMatchObject({
      hooks: {
        PreToolUse: [
          expect.objectContaining({ matcher: "^mcp__coloop__open_episode$" }),
        ],
        UserPromptSubmit: [expect.any(Object)],
      },
    });
  });

  test("plain setup resumes at the first failed saved step", async () => {
    const permissionFailure = structuredClone(readyFixture);
    permissionFailure.discord.channels[0]!.permissions = "0";
    const partial = await runCli(
      ["setup"],
      "y\ny\ny\n",
      permissionFailure,
    );
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain("Permission check failed");

    const resumed = await runCli(
      ["setup"],
      `y\n${ownerId}\ny\n`,
      readyFixture,
      {},
      partial.root,
    );

    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain(
      "Saved Discord application is valid; skipping configuration.",
    );
    expect(resumed.stdout).toContain(
      "Saved server is valid; skipping selection.",
    );
    expect(resumed.stdout).toContain(
      "Use parent channel #collaboration",
    );
    expect(resumed.stdout).not.toContain("Is this the dedicated Coloop application?");
    expect(resumed.stdout).not.toContain("Use server Test Guild");
    expect(resumed.stdout).toContain("Readiness check passed.");
  });

  test("plain setup repairs a saved Owner Pairing that no longer resolves", async () => {
    const initial = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
    );
    expect(initial.code).toBe(0);

    const changedMembership = structuredClone(readyFixture);
    changedMembership.discord.members = [
      {
        guildId: readyFixture.discord.guilds[0]!.id,
        id: replacementOwnerId,
        username: "replacement-owner",
        displayName: "Replacement Owner",
      },
    ];
    const repaired = await runCli(
      ["setup"],
      `${replacementOwnerId}\ny\n`,
      changedMembership,
      {},
      initial.root,
    );

    expect(repaired.code).toBe(0);
    expect(repaired.stdout).toContain(
      "Saved Owner Pairing no longer resolves; pairing a replacement.",
    );
    expect(repaired.stdout).toContain(
      `Resolved Owner: Replacement Owner (@replacement-owner, ${replacementOwnerId})`,
    );
    const config: unknown = JSON.parse(
      await readFile(join(repaired.root, "config", "coloop", "config.json"), "utf8"),
    );
    expect(config).toMatchObject({ ownerUserId: replacementOwnerId });
  });

  test("plain setup repairs a stale Codex MCP entry point", async () => {
    const initial = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
    );
    expect(initial.code).toBe(0);
    const state = installationStates.get(initial.root)!;
    state.mcpCommandValid = false;

    const repaired = await runCli(
      ["setup"],
      "",
      readyFixture,
      {},
      initial.root,
    );

    expect(repaired.code).toBe(0);
    expect(repaired.codexRepairs).toBe(1);
    expect(repaired.stdout).toContain(
      "Codex CLI hook and MCP entry points verified for CLI 0.150.1.",
    );
  });

  test("invalid provider credentials fail safely without exposing their values", async () => {
    const invalidDiscord = structuredClone(readyFixture);
    invalidDiscord.discord.credentialValid = false;
    const discordResult = await runCli(["setup"], "", invalidDiscord);

    expect(discordResult.code).toBe(1);
    expect(discordResult.stderr).toContain(
      "DISCORD_TOKEN was rejected by Discord.",
    );
    expect(discordResult.openedUrls).toEqual([
      "https://discord.com/developers/applications",
    ]);

    const invalidOpenAI = structuredClone(readyFixture);
    invalidOpenAI.openai.credentialValid = false;
    const openaiResult = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
      invalidOpenAI,
    );

    expect(openaiResult.code).toBe(1);
    expect(openaiResult.stderr).toContain(
      "OPENAI_API_KEY was rejected by OpenAI Platform.",
    );
    expect(openaiResult.openedUrls).toEqual([
      "https://platform.openai.com/api-keys",
    ]);
    const visibleOutput = [
      discordResult.stdout,
      discordResult.stderr,
      openaiResult.stdout,
      openaiResult.stderr,
    ].join("\n");
    expect(visibleOutput).not.toContain(readyFixture.discord.expectedCredential);
    expect(visibleOutput).not.toContain(readyFixture.openai.expectedCredential);
  });

  test("setup opens the least-privilege Discord installer only when installation is required", async () => {
    const notInstalled = structuredClone(readyFixture);
    notInstalled.discord.guilds = [];
    const result = await runCli(["setup"], "y\n", notInstalled);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "The Discord application is not installed in a server.",
    );
    expect(result.openedUrls).toHaveLength(1);
    const installer = new URL(result.openedUrls[0]!);
    expect(installer.origin + installer.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(installer.searchParams.get("client_id")).toBe(
      readyFixture.discord.application.id,
    );
    expect(installer.searchParams.get("scope")).toBe("bot applications.commands");
    expect(installer.searchParams.get("permissions")).toBe("345744935936");
  });

  test("setup rejects a dedicated application installed in more than one server", async () => {
    const installedTwice = structuredClone(readyFixture);
    installedTwice.discord.guilds.push({
      id: valueOf(parseDiscordGuildId("200000000000000099")),
      name: "Unexpected Guild",
    });

    const result = await runCli(["setup"], "y\n", installedTwice);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Remove the dedicated Discord application from every other server",
    );
    expect(result.stdout).not.toContain("Select one server by number");
  });

  test("Owner Pairing fails when the numeric identity does not resolve in the configured server", async () => {
    const unresolved = structuredClone(readyFixture);
    unresolved.discord.members = [];
    const result = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\n`,
      unresolved,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Discord user ${ownerId} could not be resolved in the configured server.`,
    );
    expect(result.stdout).not.toContain("Resolved Owner:");
    const config: unknown = JSON.parse(
      await readFile(join(result.root, "config", "coloop", "config.json"), "utf8"),
    );
    expect(config).not.toHaveProperty("ownerUserId");
  });

  test("setup stops before Owner Pairing when parent-channel permissions are insufficient", async () => {
    const insufficientPermissions = structuredClone(readyFixture);
    insufficientPermissions.discord.channels[0]!.permissions = "3072";
    const result = await runCli(
      ["setup"],
      "y\ny\ny\n",
      insufficientPermissions,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Permission check failed: View Channel, Send Messages, Create Private Threads",
    );
    expect(result.stdout).not.toContain("Owner Pairing");
  });

  test("setup rejects permissions beyond the exact least-privilege set", async () => {
    const excessivePermissions = structuredClone(readyFixture);
    excessivePermissions.discord.channels[0]!.permissions = (
      BigInt(readyFixture.discord.channels[0]!.permissions) |
      (1n << 28n)
    ).toString();

    const result = await runCli(
      ["setup"],
      "y\ny\ny\n",
      excessivePermissions,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Permission check failed: remove every permission outside the required least-privilege set.",
    );
    expect(result.stdout).not.toContain("Owner Pairing");
  });

  test("setup rejects access to every Discord channel except the selected parent", async () => {
    const unrelatedChannelAccess = structuredClone(readyFixture);
    unrelatedChannelAccess.discord.channels.push({
      guildId: readyFixture.discord.guilds[0]!.id,
      id: valueOf(parseDiscordChannelId("300000000000000099")),
      name: "general",
      permissions: "1024",
      type: "GUILD_TEXT",
    });

    const result = await runCli(
      ["setup"],
      "y\ny\n1\n",
      unrelatedChannelAccess,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Permission check failed: deny the dedicated Discord application access to every channel except #collaboration.",
    );
    expect(result.stdout).not.toContain("Owner Pairing");
  });

  test("setup does not open provider pages for transient validation failures", async () => {
    const discordUnavailable = structuredClone(readyFixture);
    discordUnavailable.discord.providerUnavailable = true;
    const discordResult = await runCli(["setup"], "", discordUnavailable);

    expect(discordResult.code).toBe(1);
    expect(discordResult.stderr).toContain(
      "Discord application validation is temporarily unavailable",
    );
    expect(discordResult.openedUrls).toEqual([]);

    const openaiUnavailable = structuredClone(readyFixture);
    openaiUnavailable.openai.providerUnavailable = true;
    const openaiResult = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
      openaiUnavailable,
    );

    expect(openaiResult.code).toBe(1);
    expect(openaiResult.stderr).toContain(
      "OpenAI Platform credential validation is temporarily unavailable",
    );
    expect(openaiResult.openedUrls).toEqual([]);
  });

  test("setup never persists either provider credential", async () => {
    const result = await runCli(
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
    );
    expect(result.code).toBe(0);

    const persisted = Buffer.concat(await readInstallationFiles(result.root));
    expect(persisted.includes(Buffer.from(readyFixture.discord.expectedCredential))).toBe(
      false,
    );
    expect(persisted.includes(Buffer.from(readyFixture.openai.expectedCredential))).toBe(
      false,
    );
    expect(result.stdout).not.toContain(readyFixture.discord.expectedCredential);
    expect(result.stdout).not.toContain(readyFixture.openai.expectedCredential);
  });

});
