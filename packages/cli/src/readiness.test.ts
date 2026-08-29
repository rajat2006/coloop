import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
  type Result,
} from "@coloop/core";
import {
  getInstallationPaths,
  initializePrivateStorage,
  saveConfig,
} from "@coloop/local-storage";
import type { ColoopDependencies } from "./dependencies.js";
import { checkReadiness } from "./readiness.js";

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
const ownerId = valueOf(parseDiscordUserId("400000000000000004"));

const createEnvironment = async (): Promise<NodeJS.ProcessEnv> => {
  const root = await mkdtemp(join(tmpdir(), "coloop-readiness-test-"));
  return {
    CODEX_HOME: join(root, "codex"),
    DISCORD_TOKEN: "discord-secret",
    OPENAI_API_KEY: "openai-secret",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
};

const createDependencies = (): ColoopDependencies => {
  const coloopEntrypoint = { args: ["/coloop/main.js"], command: "node" };
  return {
    coloopEntrypoint,
    discord: {
      connectGateway: async () => ({
        ok: true,
        value: { close: async () => {} },
      }),
      getApplication: async () => ({
        ok: true,
        value: {
          id: applicationId,
          messageContentIntentEnabled: true,
          name: "Coloop",
        },
      }),
      listChannels: async () => ({
        ok: true,
        value: [
          {
            guildId,
            id: channelId,
            name: "collaboration",
            permissions: "345744935936",
            type: "GUILD_TEXT",
          },
        ],
      }),
      listGuilds: async () => ({
        ok: true,
        value: [{ id: guildId, name: "Test Guild" }],
      }),
      resolveMember: async () => ({
        ok: true,
        value: { displayName: "Owner", id: ownerId, username: "owner" },
      }),
    },
    openExternal: async () => {},
    openai: { validateCredential: async () => ({ ok: true }) },
    runCodex: async (args) => {
      if (args[0] === "--version") {
        return { ok: true, stderr: "", stdout: "codex-cli 0.150.1\n" };
      }
      return {
        ok: true,
        stderr: "",
        stdout: JSON.stringify({
          enabled: true,
          name: "coloop",
          transport: {
            args: [...coloopEntrypoint.args, "mcp"],
            command: coloopEntrypoint.command,
            type: "stdio",
          },
        }),
      };
    },
    runColoop: async () => ({ ok: true, stderr: "", stdout: "" }),
    waitForShutdown: async () => {},
  };
};

const prepareInstallation = async (
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  const paths = getInstallationPaths(environment);
  await saveConfig(paths.configFile, {
    discordApplicationId: applicationId,
    guildId,
    ownerUserId: ownerId,
    parentChannelId: channelId,
    schemaVersion: 1,
  });
  await initializePrivateStorage(paths);
  await mkdir(paths.codexHome, { mode: 0o700, recursive: true });
  await writeFile(
    join(paths.codexHome, "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                command: "node /coloop/main.js codex-hook pre-tool-use",
                timeout: 10,
                type: "command",
              },
            ],
            matcher: "^mcp__coloop__open_episode$",
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                command:
                  "node /coloop/main.js codex-hook user-prompt-submit",
                timeout: 10,
                type: "command",
              },
            ],
          },
        ],
      },
    }),
  );
};

describe("installation readiness", () => {
  test("returns the configured runtime only after every check passes", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);

    const result = await checkReadiness(createDependencies(), environment);

    expect(result).toEqual({
      ok: true,
      value: {
        channel: expect.objectContaining({ id: channelId }),
        discordToken: "discord-secret",
        guild: expect.objectContaining({ id: guildId }),
      },
    });
  });

  test("returns an actionable failure before contacting providers when credentials are missing", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    delete environment.OPENAI_API_KEY;

    const result = await checkReadiness(createDependencies(), environment);

    expect(result).toEqual({
      message: "OPENAI_API_KEY is required to start Coloop.",
      ok: false,
      reason: "openai-credential-missing",
    });
  });

  test("classifies a rejected Discord credential", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    const dependencies = createDependencies();
    dependencies.discord.getApplication = async () => ({
      ok: false,
      reason: "credential-rejected",
    });

    expect(await checkReadiness(dependencies, environment)).toMatchObject({
      ok: false,
      reason: "discord-credential-rejected",
    });
  });

  test("rejects a parent channel whose permissions changed", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    const dependencies = createDependencies();
    dependencies.discord.listChannels = async () => ({
      ok: true,
      value: [
        {
          guildId,
          id: channelId,
          name: "collaboration",
          permissions: "0",
          type: "GUILD_TEXT",
        },
      ],
    });

    expect(await checkReadiness(dependencies, environment)).toMatchObject({
      ok: false,
      reason: "discord-channel-invalid",
    });
  });

  test("rejects an Owner who no longer resolves in the server", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    const dependencies = createDependencies();
    dependencies.discord.resolveMember = async () => ({
      ok: false,
      reason: "resource-not-found",
    });

    expect(await checkReadiness(dependencies, environment)).toMatchObject({
      ok: false,
      reason: "discord-owner-invalid",
    });
  });

  test("classifies a rejected OpenAI credential", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    const dependencies = createDependencies();
    dependencies.openai.validateCredential = async () => ({
      ok: false,
      reason: "credential-rejected",
    });

    expect(await checkReadiness(dependencies, environment)).toMatchObject({
      ok: false,
      reason: "openai-credential-rejected",
    });
  });

  test("rejects storage whose privacy guarantees changed", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    const paths = getInstallationPaths(environment);
    await chmod(paths.databaseFile, 0o644);

    expect(
      await checkReadiness(createDependencies(), environment),
    ).toMatchObject({
      ok: false,
      reason: "storage-invalid",
    });
  });

  test("rejects an invalid Codex integration", async () => {
    const environment = await createEnvironment();
    await prepareInstallation(environment);
    const dependencies = createDependencies();
    dependencies.runCodex = async () => ({
      exitCode: 1,
      ok: false,
      reason: "command-failed",
      stderr: "",
      stdout: "",
    });

    expect(await checkReadiness(dependencies, environment)).toMatchObject({
      ok: false,
      reason: "codex-integration-invalid",
    });
  });
});
