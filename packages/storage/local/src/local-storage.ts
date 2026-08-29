import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseDiscordApplicationId,
  parseDiscordChannelId,
  parseDiscordGuildId,
  parseDiscordUserId,
  type EmptyResult,
  type InstallationConfig,
  type Result,
} from "@coloop/core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (
  value: unknown,
  code: string,
): boolean => isRecord(value) && value.code === code;

const parseOptionalId = <Value>(
  value: unknown,
  parse: (candidate: unknown) =>
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly reason: string },
): Value | undefined => {
  if (value === undefined) return undefined;
  const result = parse(value);
  if (!result.ok) throw new Error("invalid configuration identity");
  return result.value;
};

export interface InstallationPaths {
  artifactsDirectory: string;
  codexHome: string;
  configFile: string;
  databaseFile: string;
  stateDirectory: string;
}

export const getInstallationPaths = (
  environment: NodeJS.ProcessEnv,
): InstallationPaths => {
  const userHome = homedir();
  const configRoot = environment.XDG_CONFIG_HOME ?? join(userHome, ".config");
  const stateRoot = environment.XDG_STATE_HOME ?? join(userHome, ".local", "state");
  const stateDirectory = join(stateRoot, "coloop");

  return {
    artifactsDirectory: join(stateDirectory, "episodes"),
    codexHome: environment.CODEX_HOME ?? join(userHome, ".codex"),
    configFile: join(configRoot, "coloop", "config.json"),
    databaseFile: join(stateDirectory, "coloop.sqlite"),
    stateDirectory,
  };
};

export const loadConfig = async (
  configFile: string,
): Promise<Result<InstallationConfig, "configuration-unreadable">> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("invalid configuration document");
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error("unsupported configuration schema");
    }
    const discordApplicationId = parseOptionalId(
      parsed.discordApplicationId,
      parseDiscordApplicationId,
    );
    const guildId = parseOptionalId(parsed.guildId, parseDiscordGuildId);
    const ownerUserId = parseOptionalId(parsed.ownerUserId, parseDiscordUserId);
    const parentChannelId = parseOptionalId(
      parsed.parentChannelId,
      parseDiscordChannelId,
    );
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        ...(discordApplicationId ? { discordApplicationId } : {}),
        ...(guildId ? { guildId } : {}),
        ...(ownerUserId ? { ownerUserId } : {}),
        ...(parentChannelId ? { parentChannelId } : {}),
      },
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { ok: true, value: { schemaVersion: 1 } };
    }
    return { ok: false, reason: "configuration-unreadable" };
  }
};

export const saveConfig = async (
  configFile: string,
  config: InstallationConfig,
): Promise<void> => {
  const directory = dirname(configFile);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  // Writing then renaming prevents an interruption from leaving partial JSON behind.
  const temporaryFile = `${configFile}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryFile, 0o600);
  await rename(temporaryFile, configFile);
  await chmod(configFile, 0o600);
};

export const initializePrivateStorage = async (
  paths: InstallationPaths,
): Promise<void> => {
  // State, artifacts, and the database are Owner-only even when they already exist.
  await mkdir(paths.stateDirectory, { mode: 0o700, recursive: true });
  await mkdir(paths.artifactsDirectory, { mode: 0o700, recursive: true });
  await chmod(paths.stateDirectory, 0o700);
  await chmod(paths.artifactsDirectory, 0o700);

  const database = new DatabaseSync(paths.databaseFile);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        version INTEGER PRIMARY KEY,
        initialized_at TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO schema_metadata (version, initialized_at)
      VALUES (1, datetime('now'));
    `);
  } finally {
    database.close();
  }
  await chmod(paths.databaseFile, 0o600);
};

export const verifyPrivateStorage = async (
  paths: InstallationPaths,
): Promise<EmptyResult<"storage-invalid">> => {
  try {
    // Readiness covers path types, privacy bits, and the initialized schema marker.
    const [state, artifacts, databaseFile] = await Promise.all([
      stat(paths.stateDirectory),
      stat(paths.artifactsDirectory),
      stat(paths.databaseFile),
    ]);
    if (!state.isDirectory() || !artifacts.isDirectory() || !databaseFile.isFile()) {
      throw new Error("invalid storage paths");
    }
    if (
      (state.mode & 0o077) !== 0 ||
      (artifacts.mode & 0o077) !== 0 ||
      (databaseFile.mode & 0o077) !== 0
    ) {
      throw new Error("storage permissions are not Owner-private");
    }
    const database = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try {
      const row: unknown = database
        .prepare("SELECT version FROM schema_metadata WHERE version = 1")
        .get();
      if (!isRecord(row) || row.version !== 1) {
        throw new Error("storage schema is not initialized");
      }
    } finally {
      database.close();
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage-invalid" };
  }
};
