import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ColoopDependencies } from "./dependencies.js";

const supportedCodexVersion = "codex-cli 0.150.1";
const preToolMatcher = "^mcp__coloop__open_episode$";

interface HooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

const coloopPreToolHook = {
  matcher: preToolMatcher,
  hooks: [
    {
      type: "command",
      command: "coloop codex-hook pre-tool-use",
      timeout: 10,
    },
  ],
};

const coloopPromptHook = {
  hooks: [
    {
      type: "command",
      command: "coloop codex-hook user-prompt-submit",
      timeout: 10,
    },
  ],
};

const matchesPreToolMatcher = (entry: unknown): boolean =>
  typeof entry === "object" &&
  entry !== null &&
  "matcher" in entry &&
  entry.matcher === preToolMatcher;

const containsColoopHook = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.some(
    (entry) =>
      matchesPreToolMatcher(entry) &&
      JSON.stringify(entry) === JSON.stringify(coloopPreToolHook),
  );

const containsPromptHook = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.some(
    (entry) => JSON.stringify(entry) === JSON.stringify(coloopPromptHook),
  );

const verifyCodexVersion = async (
  dependencies: ColoopDependencies,
): Promise<void> => {
  const version = await dependencies.runCodex(["--version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== supportedCodexVersion) {
    throw new Error(
      `Supported Codex CLI ${supportedCodexVersion.replace("codex-cli ", "")} is required.`,
    );
  }
};

const verifyMcpEntryPoint = async (
  dependencies: ColoopDependencies,
): Promise<void> => {
  const mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  if (mcp.exitCode !== 0 || !isExpectedMcpConfiguration(mcp.stdout)) {
    throw new Error("Codex MCP entry point could not be verified.");
  }
};

const isExpectedMcpConfiguration = (stdout: string): boolean => {
  try {
    const configuration = JSON.parse(stdout) as {
      enabled?: unknown;
      name?: unknown;
      transport?: { args?: unknown; command?: unknown; type?: unknown };
    };
    return (
      configuration.name === "coloop" &&
      configuration.enabled === true &&
      configuration.transport?.type === "stdio" &&
      configuration.transport.command === "coloop" &&
      Array.isArray(configuration.transport.args) &&
      configuration.transport.args.length === 1 &&
      configuration.transport.args[0] === "mcp"
    );
  } catch {
    return false;
  }
};

const verifyHookEntryPoint = async (codexHome: string): Promise<void> => {
  try {
    const hooksPath = join(codexHome, "hooks.json");
    const verified = JSON.parse(await readFile(hooksPath, "utf8")) as HooksFile;
    if (
      !containsColoopHook(verified.hooks?.PreToolUse) ||
      !containsPromptHook(verified.hooks?.UserPromptSubmit)
    ) {
      throw new Error("missing Coloop hook");
    }
  } catch {
    throw new Error("Codex hook entry point could not be verified.");
  }
};

export const verifyCodexIntegration = async (
  codexHome: string,
  dependencies: ColoopDependencies,
): Promise<void> => {
  await verifyCodexVersion(dependencies);
  await verifyMcpEntryPoint(dependencies);
  await verifyHookEntryPoint(codexHome);
};

export const installAndVerifyCodexIntegration = async (
  codexHome: string,
  dependencies: ColoopDependencies,
): Promise<void> => {
  await verifyCodexVersion(dependencies);

  let mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  if (mcp.exitCode !== 0 || !isExpectedMcpConfiguration(mcp.stdout)) {
    if (mcp.exitCode === 0) {
      const removed = await dependencies.runCodex(["mcp", "remove", "coloop"]);
      if (removed.exitCode !== 0) {
        throw new Error("Stale Codex MCP entry point could not be replaced.");
      }
    }
    const added = await dependencies.runCodex([
      "mcp",
      "add",
      "coloop",
      "--",
      "coloop",
      "mcp",
    ]);
    if (added.exitCode !== 0) {
      throw new Error("Codex MCP entry point could not be installed.");
    }
    mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  }
  if (mcp.exitCode !== 0) {
    throw new Error("Codex MCP entry point could not be verified.");
  }

  await mkdir(codexHome, { mode: 0o700, recursive: true });
  await chmod(codexHome, 0o700);
  const hooksPath = join(codexHome, "hooks.json");
  let document: HooksFile = {};
  try {
    const parsed = JSON.parse(await readFile(hooksPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid hooks document");
    }
    document = parsed as HooksFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Existing Codex hooks.json is not valid JSON.");
    }
  }

  const hooks =
    typeof document.hooks === "object" && document.hooks !== null
      ? { ...document.hooks }
      : {};
  const preToolUse = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse.filter((entry) => !matchesPreToolMatcher(entry))
    : [];
  preToolUse.push(coloopPreToolHook);
  const userPromptSubmit = Array.isArray(hooks.UserPromptSubmit)
    ? [...hooks.UserPromptSubmit]
    : [];
  if (
    !userPromptSubmit.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(coloopPromptHook),
    )
  ) {
    userPromptSubmit.push(coloopPromptHook);
  }

  const nextDocument: HooksFile = {
    ...document,
    hooks: { ...hooks, PreToolUse: preToolUse, UserPromptSubmit: userPromptSubmit },
  };
  await writeFile(hooksPath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(hooksPath, 0o600);

  await verifyCodexIntegration(codexHome, dependencies);
};
