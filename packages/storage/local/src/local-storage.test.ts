import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
  type InstallationConfig,
  type Result,
} from "@coloop/core";
import {
  getInstallationPaths,
  initializePrivateStorage,
  loadConfig,
  saveConfig,
  verifyPrivateStorage,
} from "./local-storage.js";

const valueOf = <Value>(
  result: Result<Value, "invalid-discord-id">,
): Value => {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
};

const readyConfig: InstallationConfig = {
  discordApplicationId: valueOf(
    parseDiscordApplicationId("100000000000000001"),
  ),
  guildId: valueOf(parseDiscordGuildId("200000000000000002")),
  ownerUserId: valueOf(parseDiscordUserId("300000000000000003")),
  parentChannelId: valueOf(parseDiscordChannelId("400000000000000004")),
  schemaVersion: 1,
};

describe("local configuration", () => {
  test("round-trips validated non-secret installation data privately", async () => {
    const root = await mkdtemp(join(tmpdir(), "coloop-config-test-"));
    const configFile = join(root, "config", "config.json");

    await saveConfig(configFile, readyConfig);

    expect(await loadConfig(configFile)).toEqual({
      ok: true,
      value: readyConfig,
    });
    expect((await stat(configFile)).mode & 0o077).toBe(0);
    expect(await readFile(configFile, "utf8")).not.toContain("TOKEN");
  });

  test("rejects malformed saved identities at the filesystem boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "coloop-config-test-"));
    const configFile = join(root, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({ ownerUserId: "owner-name", schemaVersion: 1 }),
    );

    expect(await loadConfig(configFile)).toEqual({
      ok: false,
      reason: "configuration-unreadable",
    });
  });
});

describe("local private storage", () => {
  test("initializes storage that passes path, privacy, and schema checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "coloop-storage-test-"));
    const paths = getInstallationPaths({
      CODEX_HOME: join(root, "codex"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });

    await initializePrivateStorage(paths);

    expect(await verifyPrivateStorage(paths)).toEqual({ ok: true });
  });

  test("rejects storage that is readable by other users", async () => {
    const root = await mkdtemp(join(tmpdir(), "coloop-storage-test-"));
    const paths = getInstallationPaths({
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });
    await initializePrivateStorage(paths);
    await chmod(paths.databaseFile, 0o644);

    expect(await verifyPrivateStorage(paths)).toEqual({
      ok: false,
      reason: "storage-invalid",
    });
  });

  test("rejects storage without the initialized schema marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "coloop-storage-test-"));
    const paths = getInstallationPaths({
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });
    await initializePrivateStorage(paths);
    const database = new DatabaseSync(paths.databaseFile);
    try {
      database.exec("DELETE FROM schema_metadata WHERE version = 1");
    } finally {
      database.close();
    }

    expect(await verifyPrivateStorage(paths)).toEqual({
      ok: false,
      reason: "storage-invalid",
    });
  });
});
