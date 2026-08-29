import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  installAndVerifyCodexIntegration,
  verifyCodexIntegration,
  type CodexIntegrationDependencies,
} from "./installation.js";

const createDependencies = (): CodexIntegrationDependencies => {
  const coloopEntrypoint = { args: ["/coloop/main.js"], command: "node" };
  let mcpInstalled = false;
  return {
    coloopEntrypoint,
    runCodex: async (args) => {
      if (args[0] === "--version") {
        return { ok: true, stderr: "", stdout: "codex-cli 0.150.1\n" };
      }
      if (args[0] === "mcp" && args[1] === "add") {
        mcpInstalled = true;
        return { ok: true, stderr: "", stdout: "added\n" };
      }
      if (args[0] === "mcp" && args[1] === "get" && mcpInstalled) {
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
      }
      return {
        exitCode: 1,
        ok: false,
        reason: "command-failed",
        stderr: "not found\n",
        stdout: "",
      };
    },
    runColoop: async () => ({ ok: true, stderr: "", stdout: "" }),
  };
};

describe("Codex integration installation", () => {
  test("installs verifiable entry points while preserving unrelated hooks", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "coloop-codex-test-"));
    await writeFile(
      join(codexHome, "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } }),
    );
    const dependencies = createDependencies();

    await installAndVerifyCodexIntegration(codexHome, dependencies);

    const hooks: unknown = JSON.parse(
      await readFile(join(codexHome, "hooks.json"), "utf8"),
    );
    expect(hooks).toMatchObject({
      hooks: {
        PreToolUse: [expect.objectContaining({ matcher: "^mcp__coloop__open_episode$" })],
        Stop: [{ hooks: [{ type: "command" }] }],
        UserPromptSubmit: [expect.any(Object)],
      },
    });
    expect(await verifyCodexIntegration(codexHome, dependencies)).toEqual({
      ok: true,
    });
  });

  test("rejects malformed MCP configuration instead of trusting parsed JSON", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "coloop-codex-test-"));
    const dependencies = createDependencies();
    dependencies.runCodex = async (args) =>
      args[0] === "--version"
        ? { ok: true, stderr: "", stdout: "codex-cli 0.150.1\n" }
        : { ok: true, stderr: "", stdout: "null" };

    expect(await verifyCodexIntegration(codexHome, dependencies)).toEqual({
      ok: false,
      reason: "codex-integration-invalid",
    });
  });
});
