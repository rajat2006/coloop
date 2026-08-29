import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(testDirectory);
const cliPath = join(packageDirectory, "dist", "main.js");
const preloadPath = join(testDirectory, "test-support", "provider-preload.mjs");
const fakeCodexPath = join(testDirectory, "test-support", "fake-codex.mjs");
const fakeOpenPath = join(testDirectory, "test-support", "fake-open.mjs");
const ownerId = "123456789012345678";
const requiredPermissions = "345744935936";

const providerFixture = {
  applicationId: "100000000000000001",
  botId: "100000000000000009",
  channelId: "300000000000000003",
  discordToken: "discord-black-box-secret",
  guildId: "200000000000000002",
  openaiApiKey: "openai-black-box-secret",
  ownerId,
  permissions: requiredPermissions,
};

interface Harness {
  bin: string;
  codexState: string;
  fixturePath: string;
  installation: string;
  openLog: string;
}

interface ProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

const createHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "coloop-black-box-"));
  const bin = join(root, "bin");
  const installation = join(root, "installation");
  await mkdir(bin, { recursive: true });
  await mkdir(installation, { recursive: true });
  await copyFile(fakeCodexPath, join(bin, "codex"));
  await copyFile(fakeOpenPath, join(bin, "xdg-open"));
  await chmod(join(bin, "codex"), 0o700);
  await chmod(join(bin, "xdg-open"), 0o700);
  return {
    bin,
    codexState: join(root, "codex-state.json"),
    fixturePath: join(root, "provider-fixture.json"),
    installation,
    openLog: join(root, "opened-urls.txt"),
  };
};

const runBuiltCli = async (
  harness: Harness,
  args: string[],
  input: string,
  fixture: object = providerFixture,
  stopWhenRunning = false,
): Promise<ProcessResult> => {
  await writeFile(harness.fixturePath, JSON.stringify(fixture));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: join(harness.installation, "home", ".codex"),
    COLOOP_TEST_CODEX_STATE: harness.codexState,
    COLOOP_TEST_OPEN_LOG: harness.openLog,
    COLOOP_TEST_PROVIDER_FIXTURE: harness.fixturePath,
    DISCORD_TOKEN: providerFixture.discordToken,
    HOME: join(harness.installation, "home"),
    NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
    OPENAI_API_KEY: providerFixture.openaiApiKey,
    PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(harness.installation, "config"),
    XDG_STATE_HOME: join(harness.installation, "state"),
  };

  const outputDirectory = await mkdtemp(join(tmpdir(), "coloop-cli-output-"));
  const stdoutPath = join(outputDirectory, "stdout.txt");
  const stderrPath = join(outputDirectory, "stderr.txt");
  const stdinPath = join(outputDirectory, "stdin.txt");
  await writeFile(stdinPath, input);
  const stdinFile = await open(stdinPath, "r");
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: environment,
      stdio: [stdinFile.fd, stdoutFile.fd, stderrFile.fd],
    });
    let stopping = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI timed out."));
    }, 15_000);
    const runtimePoll = stopWhenRunning
      ? setInterval(() => {
          void readFile(stdoutPath, "utf8").then((stdout) => {
            if (
              !stopping &&
              stdout.includes("Coloop is running in the foreground")
            ) {
              stopping = true;
              child.kill("SIGTERM");
            }
          });
        }, 25)
      : undefined;
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (runtimePoll) clearInterval(runtimePoll);
      void Promise.all([
        stdinFile.close(),
        stdoutFile.close(),
        stderrFile.close(),
      ]).then(async () => {
        resolve({
          code,
          stderr: await readFile(stderrPath, "utf8"),
          stdout: await readFile(stdoutPath, "utf8"),
        });
      });
    });
  });
};

const readFiles = async (directory: string): Promise<Buffer[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Buffer[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await readFiles(path)));
    if (entry.isFile()) files.push(await readFile(path));
  }
  return files;
};

describe("built coloop CLI", () => {
  test("covers setup, recovery, provider failures, readiness, privacy, and runtime across the process boundary", async () => {
    // Internal Codex entry points must work through the built executable.
    const freshHarness = await createHarness();
    const mcp = await runBuiltCli(
      freshHarness,
      ["mcp"],
      `${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" })}\n`,
    );
    expect(mcp.code, mcp.stderr).toBe(0);
    expect(mcp.stdout).toContain('"name":"open_episode"');
    const hook = await runBuiltCli(
      freshHarness,
      ["codex-hook", "pre-tool-use"],
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "trusted-session",
        tool_input: { opening_brief: "Verify the hook executable" },
        tool_name: "mcp__coloop__open_episode",
        transcript_path: "/trusted/transcript.jsonl",
        turn_id: "trusted-turn",
      }),
    );
    expect(hook.code, hook.stderr).toBe(0);
    expect(hook.stdout).toContain('"_origin_session_id":"trusted-session"');
    const usage = await runBuiltCli(freshHarness, [], "");
    expect(usage, `cli=${cliPath}`).toEqual({
      code: 2,
      stderr: "Usage: coloop <setup|run>\n",
      stdout: "",
    });
    // A fresh installation must complete without persisting either provider secret.
    const fresh = await runBuiltCli(
      freshHarness,
      ["setup"],
      `y\ny\ny\n${ownerId}\ny\n`,
    );
    expect(
      fresh.code,
      `stdout=${fresh.stdout}\nstderr=${fresh.stderr}`,
    ).toBe(0);
    expect(fresh.stdout).toContain("Readiness check passed.");

    const persisted = Buffer.concat(await readFiles(freshHarness.installation));
    expect(persisted.includes(Buffer.from(providerFixture.discordToken))).toBe(
      false,
    );
    expect(persisted.includes(Buffer.from(providerFixture.openaiApiKey))).toBe(
      false,
    );

    // A ready installation opens and cleanly closes the foreground Gateway runtime.
    const runtime = await runBuiltCli(
      freshHarness,
      ["run"],
      "",
      providerFixture,
      true,
    );
    expect(runtime.code, runtime.stderr).toBe(0);
    expect(runtime.stdout).toContain(
      "Coloop is running in the foreground for Black Box Guild/#collaboration.",
    );

    const invalidRuntime = await runBuiltCli(
      freshHarness,
      ["run"],
      "",
      { ...providerFixture, openaiStatus: 401 },
    );
    expect(invalidRuntime.code).toBe(1);
    expect(invalidRuntime.stderr).toContain(
      "OPENAI_API_KEY was rejected by OpenAI Platform.",
    );

    // Interrupted setup resumes from saved non-secret progress and repairs stale state.
    const recoveryHarness = await createHarness();
    const permissionFailure = await runBuiltCli(
      recoveryHarness,
      ["setup"],
      "y\ny\ny\n",
      { ...providerFixture, permissions: "3072" },
    );
    expect(permissionFailure.code).toBe(1);
    expect(permissionFailure.stderr).toContain("Permission check failed");
    const recovered = await runBuiltCli(
      recoveryHarness,
      ["setup"],
      `y\n${ownerId}\ny\n`,
    );
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain(
      "Saved Discord application is valid; skipping configuration.",
    );
    expect(recovered.stdout).toContain("Readiness check passed.");

    const ownerLookupFailure = await runBuiltCli(
      recoveryHarness,
      ["setup"],
      "",
      { ...providerFixture, ownerStatus: 503 },
    );
    expect(ownerLookupFailure.code).toBe(1);
    expect(ownerLookupFailure.stderr).toContain(
      "Discord Owner Pairing validation is temporarily unavailable",
    );
    const recoveredConfig = await readFile(
      join(
        recoveryHarness.installation,
        "config",
        "coloop",
        "config.json",
      ),
      "utf8",
    );
    expect(JSON.parse(recoveredConfig)).toMatchObject({ ownerUserId: ownerId });

    // Provider and identity failures remain actionable without exposing credentials.
    const invalidCredentialHarness = await createHarness();
    const invalidCredential = await runBuiltCli(
      invalidCredentialHarness,
      ["setup"],
      "",
      { ...providerFixture, discordStatus: 401 },
    );
    expect(invalidCredential.code).toBe(1);
    expect(invalidCredential.stderr).toContain(
      "DISCORD_TOKEN was rejected by Discord.",
    );
    expect(invalidCredential.stderr).not.toContain(providerFixture.discordToken);

    const unresolvedHarness = await createHarness();
    const unresolvedOwner = await runBuiltCli(
      unresolvedHarness,
      ["setup"],
      `y\ny\ny\n${ownerId}\n`,
      { ...providerFixture, ownerResolves: false },
    );
    expect(unresolvedOwner.code).toBe(1);
    expect(unresolvedOwner.stderr).toContain(
      `Discord user ${ownerId} could not be resolved`,
    );
  }, 60_000);
});
