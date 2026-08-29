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

export interface InstallationConfig {
  discordApplicationId?: string;
  guildId?: string;
  ownerUserId?: string;
  parentChannelId?: string;
  schemaVersion: 1;
}

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
): Promise<InstallationConfig> => {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as Record<
      string,
      unknown
    >;
    if (parsed.schemaVersion !== 1) {
      throw new Error("unsupported configuration schema");
    }
    return {
      schemaVersion: 1,
      ...(typeof parsed.discordApplicationId === "string"
        ? { discordApplicationId: parsed.discordApplicationId }
        : {}),
      ...(typeof parsed.guildId === "string" ? { guildId: parsed.guildId } : {}),
      ...(typeof parsed.ownerUserId === "string"
        ? { ownerUserId: parsed.ownerUserId }
        : {}),
      ...(typeof parsed.parentChannelId === "string"
        ? { parentChannelId: parsed.parentChannelId }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1 };
    }
    throw new Error("Saved Coloop configuration is unreadable or unsupported.");
  }
};

export const saveConfig = async (
  configFile: string,
  config: InstallationConfig,
): Promise<void> => {
  const directory = dirname(configFile);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
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
): Promise<void> => {
  try {
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
      const row = database
        .prepare("SELECT version FROM schema_metadata WHERE version = 1")
        .get() as { version?: number } | undefined;
      if (row?.version !== 1) {
        throw new Error("storage schema is not initialized");
      }
    } finally {
      database.close();
    }
  } catch {
    throw new Error(
      "Owner-private SQLite and Episode-artifact storage are not ready; rerun `coloop setup`.",
    );
  }
};
