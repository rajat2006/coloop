import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS_STORE_LINE,
  OPENAI_KEY_VARS,
  prepareCodexAuth,
} from "./prepare-codex-auth";

const AUTH_JSON = '{"tokens":{"access_token":"tok"},"OPENAI_API_KEY":null}';

describe("prepareCodexAuth — materialise the Codex subscription seat before run()", () => {
  let codexHome: string;
  /** An isolated env object so tests never mutate the real process.env. */
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    env = { CODEX_HOME: codexHome, CODEX_AUTH_JSON: AUTH_JSON };
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("writes CODEX_AUTH_JSON verbatim to $CODEX_HOME/auth.json", () => {
    prepareCodexAuth("codex", env);

    const written = fs.readFileSync(path.join(codexHome, "auth.json"), "utf8");
    expect(written).toBe(AUTH_JSON);
  });

  it("writes auth.json with owner-only (0600) permissions", () => {
    prepareCodexAuth("codex", env);

    const mode = fs.statSync(path.join(codexHome, "auth.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("selects the file credential store in config.toml", () => {
    prepareCodexAuth("codex", env);

    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(CREDENTIALS_STORE_LINE);
  });

  it("strips OPENAI_KEY and OPENAI_API_KEY from the env", () => {
    env.OPENAI_KEY = "sk-key";
    env.OPENAI_API_KEY = "sk-api-key";

    prepareCodexAuth("codex", env);

    for (const name of OPENAI_KEY_VARS) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("creates $CODEX_HOME when it does not yet exist", () => {
    const nested = path.join(codexHome, "does", "not", "exist");
    env.CODEX_HOME = nested;

    prepareCodexAuth("codex", env);

    expect(fs.existsSync(path.join(nested, "auth.json"))).toBe(true);
  });

  it("preserves existing config.toml content while adding the store line", () => {
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\n',
    );

    prepareCodexAuth("codex", env);

    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain(CREDENTIALS_STORE_LINE);
  });

  it("rewrites a stale credential-store value to file", () => {
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      'cli_auth_credentials_store = "keyring"\n',
    );

    prepareCodexAuth("codex", env);

    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(CREDENTIALS_STORE_LINE);
    expect(config).not.toContain("keyring");
  });

  it("is idempotent — a second run does not duplicate the store line", () => {
    prepareCodexAuth("codex", env);
    env.CODEX_AUTH_JSON = AUTH_JSON; // (unchanged; re-run the whole prep)
    prepareCodexAuth("codex", env);

    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const occurrences = config.split("cli_auth_credentials_store").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves an existing auth.json — never clobbers a phase's refreshed creds", () => {
    const refreshed = '{"tokens":{"access_token":"REFRESHED-in-place"}}';
    fs.writeFileSync(path.join(codexHome, "auth.json"), refreshed);
    // The secret still holds the original (now stale) seed; it must be ignored.

    prepareCodexAuth("codex", env);

    const written = fs.readFileSync(path.join(codexHome, "auth.json"), "utf8");
    expect(written).toBe(refreshed);
  });

  it("does not require CODEX_AUTH_JSON when auth.json already exists", () => {
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":{}}');
    delete env.CODEX_AUTH_JSON; // a later phase need not re-supply the seed
    env.OPENAI_API_KEY = "sk-key";

    expect(() => prepareCodexAuth("codex", env)).not.toThrow();

    // The idempotent setup still runs on the existing-file path.
    expect(
      fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"),
    ).toContain(CREDENTIALS_STORE_LINE);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("throws when Codex is selected but CODEX_AUTH_JSON is missing", () => {
    delete env.CODEX_AUTH_JSON;

    expect(() => prepareCodexAuth("codex", env)).toThrow(/CODEX_AUTH_JSON/);
  });

  it("throws on a mangled (non-JSON) CODEX_AUTH_JSON secret", () => {
    env.CODEX_AUTH_JSON = "not json {{{";

    expect(() => prepareCodexAuth("codex", env)).toThrow(/not valid JSON/);
  });

  it("is a no-op when the run resolved to Claude Code — writes nothing, strips nothing", () => {
    env.OPENAI_API_KEY = "sk-should-survive-non-codex";

    prepareCodexAuth("claude-code", env);

    expect(fs.existsSync(path.join(codexHome, "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
    // The no-op path touches nothing, including OpenAI vars (the workflow simply
    // never sets them on the Claude path).
    expect(env.OPENAI_API_KEY).toBe("sk-should-survive-non-codex");
  });
});
