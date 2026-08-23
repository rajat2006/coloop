import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requireEnv } from "./require-env";

/**
 * The provider name Sandcastle's `codex()` builder reports (`ctx.agent.name`).
 * Only this provider needs the auth-file materialisation below; Claude Code
 * authenticates purely from `CLAUDE_CODE_OAUTH_TOKEN` in the env. Keyed off the
 * RESOLVED provider, so it is correct whichever way `DEFAULT_PROVIDER` points.
 */
export const CODEX_PROVIDER = "codex";

/**
 * The credential-store setting Codex CI requires. The default store is the OS
 * keyring, which is unreachable on the Actions runner, so `codex exec` must be
 * told to read the file-based store (the `auth.json` we write below) instead.
 */
export const CREDENTIALS_STORE_LINE = 'cli_auth_credentials_store = "file"';

/** OpenAI API-key vars that must never be visible to `codex exec`. */
export const OPENAI_KEY_VARS = ["OPENAI_KEY", "OPENAI_API_KEY"] as const;

/**
 * Prepare the runner environment so `codex exec` authenticates against the
 * ChatGPT subscription seat (`gpt-5.6-sol`) rather than the metered Platform API.
 * Called by every capability script immediately before `sandcastle.run()`, so the
 * setup is uniform across phases (spec #52 / #64).
 *
 * When the run resolved to Claude Code (`providerName !== "codex"`) this is a no-op — its
 * token lives in the env and needs no file materialisation.
 *
 * For Codex it does three things, in the order Codex needs them:
 *
 * 1. Seed `$CODEX_HOME/auth.json` from `CODEX_AUTH_JSON` (mode 0600) — but ONLY
 *    when the file is absent. Codex refreshes the ChatGPT tokens *in place*
 *    during a run, so once an earlier phase (implement) has written the file,
 *    re-seeding it in a later phase (write-pr) would discard the freshly
 *    refreshed credentials and restore the stale seed. `$CODEX_HOME` is stable
 *    across a job's steps, so seed-if-absent keeps the first-phase refresh live
 *    for every later phase (OpenAI CI guidance; see `docs/agents/sandcastle.md`).
 * 2. Ensure `$CODEX_HOME/config.toml` sets {@link CREDENTIALS_STORE_LINE}, so
 *    Codex reads that file rather than the unreachable OS keyring.
 * 3. Strip `OPENAI_KEY` / `OPENAI_API_KEY` from the env — if either is present
 *    Codex bills the metered API and can fail `Quota exceeded` even with a valid
 *    subscription. The workflow does not set them; this is the defensive backstop.
 *
 * Steps 2–3 run every phase (idempotent, per-process); only the seed in step 1
 * is guarded on the file's absence.
 *
 * When it does seed, `CODEX_AUTH_JSON` is validated as JSON and required: a
 * missing/mangled secret on the first phase is a wiring bug that should land the
 * issue in `agent:blocked`, not silently fall through to a broken run.
 *
 * @param providerName the resolved provider (`ctx.agent.name`)
 * @param env the environment to read the secret from and strip keys on; defaults
 *   to `process.env` (the live env `run()` hands to the spawned `codex exec`)
 */
export function prepareCodexAuth(
  providerName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (providerName !== CODEX_PROVIDER) {
    return;
  }

  const codexHome = env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");

  fs.mkdirSync(codexHome, { recursive: true });

  // Seed only when absent — never clobber a refreshed auth.json a prior phase
  // wrote (see the header note). The secret is read only on the seeding path, so
  // a later phase does not depend on it still being in the env.
  if (!fs.existsSync(authPath)) {
    const authJson = requireEnv("CODEX_AUTH_JSON", env);
    try {
      JSON.parse(authJson);
    } catch (cause) {
      throw new Error(
        "CODEX_AUTH_JSON is not valid JSON — paste the whole contents of ~/.codex/auth.json as the secret value.",
        { cause },
      );
    }
    fs.writeFileSync(authPath, authJson, { mode: 0o600 });
  }

  ensureFileCredentialStore(path.join(codexHome, "config.toml"));

  for (const name of OPENAI_KEY_VARS) {
    delete env[name];
  }
}

/**
 * Write (or reconcile) `config.toml` so the file credential store is selected.
 * A pre-existing `cli_auth_credentials_store = …` line is rewritten to `"file"`
 * so a stale keyring value can't win; otherwise the setting is appended, leaving
 * any other config the operator committed intact.
 */
function ensureFileCredentialStore(configPath: string): void {
  const keyLine = /^\s*cli_auth_credentials_store\s*=.*$/m;
  let content = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";

  if (keyLine.test(content)) {
    content = content.replace(keyLine, CREDENTIALS_STORE_LINE);
  } else {
    const body = content.replace(/\s*$/, "");
    content = body ? `${body}\n${CREDENTIALS_STORE_LINE}\n` : `${CREDENTIALS_STORE_LINE}\n`;
  }

  fs.writeFileSync(configPath, content);
}
