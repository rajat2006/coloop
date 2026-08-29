import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface CommandInvocation {
  args: string[];
  command: string;
}

export interface CodexIntegrationDependencies {
  coloopEntrypoint: CommandInvocation;
  runCodex(args: string[]): Promise<CommandResult>;
  runColoop(args: string[], input: string): Promise<CommandResult>;
}

const supportedCodexVersion = "codex-cli 0.150.1";
const preToolMatcher = "^mcp__coloop__open_episode$";

interface HooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

const quoteShellArgument = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;

const hookCommand = (
  dependencies: CodexIntegrationDependencies,
  hook: "pre-tool-use" | "user-prompt-submit",
): string =>
  // Hooks must call the exact executable being verified, including wrapper arguments.
  [
    dependencies.coloopEntrypoint.command,
    ...dependencies.coloopEntrypoint.args,
    "codex-hook",
    hook,
  ]
    .map(quoteShellArgument)
    .join(" ");

const coloopPreToolHook = (dependencies: CodexIntegrationDependencies) => ({
  hooks: [
    {
      command: hookCommand(dependencies, "pre-tool-use"),
      timeout: 10,
      type: "command",
    },
  ],
  matcher: preToolMatcher,
});

const coloopPromptHook = (dependencies: CodexIntegrationDependencies) => ({
  hooks: [
    {
      command: hookCommand(dependencies, "user-prompt-submit"),
      timeout: 10,
      type: "command",
    },
  ],
});

const matchesPreToolMatcher = (entry: unknown): boolean =>
  typeof entry === "object" &&
  entry !== null &&
  "matcher" in entry &&
  entry.matcher === preToolMatcher;

const containsColoopHook = (
  value: unknown,
  dependencies: CodexIntegrationDependencies,
): boolean =>
  Array.isArray(value) &&
  value.some(
    (entry) =>
      matchesPreToolMatcher(entry) &&
      JSON.stringify(entry) === JSON.stringify(coloopPreToolHook(dependencies)),
  );

const containsPromptHook = (
  value: unknown,
  dependencies: CodexIntegrationDependencies,
): boolean =>
  Array.isArray(value) &&
  value.some(
    (entry) =>
      JSON.stringify(entry) === JSON.stringify(coloopPromptHook(dependencies)),
  );

const verifyCodexVersion = async (
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  const version = await dependencies.runCodex(["--version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== supportedCodexVersion) {
    throw new Error(
      `Supported Codex CLI ${supportedCodexVersion.replace("codex-cli ", "")} is required.`,
    );
  }
};

const isExpectedMcpConfiguration = (
  stdout: string,
  dependencies: CodexIntegrationDependencies,
): boolean => {
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
      configuration.transport.command ===
        dependencies.coloopEntrypoint.command &&
      Array.isArray(configuration.transport.args) &&
      JSON.stringify(configuration.transport.args) ===
        JSON.stringify([...dependencies.coloopEntrypoint.args, "mcp"])
    );
  } catch {
    return false;
  }
};

const verifyMcpEntryPoint = async (
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  const mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  if (
    mcp.exitCode !== 0 ||
    !isExpectedMcpConfiguration(mcp.stdout, dependencies)
  ) {
    throw new Error("Codex MCP entry point could not be verified.");
  }
};

const verifyHookEntryPoint = async (
  codexHome: string,
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  try {
    const hooksPath = join(codexHome, "hooks.json");
    const verified = JSON.parse(await readFile(hooksPath, "utf8")) as HooksFile;
    if (
      !containsColoopHook(verified.hooks?.PreToolUse, dependencies) ||
      !containsPromptHook(verified.hooks?.UserPromptSubmit, dependencies)
    ) {
      throw new Error("missing Coloop hook");
    }
  } catch {
    throw new Error("Codex hook entry point could not be verified.");
  }
};

const verifyRunnableEntrypoint = async (
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  const result = await dependencies.runColoop(["verify-entrypoint"], "");
  if (result.exitCode !== 0) {
    throw new Error("Coloop executable entry point could not be verified.");
  }
};

export const verifyCodexIntegration = async (
  codexHome: string,
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  // Runtime verification is intentionally read-only; setup owns all repairs.
  await verifyCodexVersion(dependencies);
  await verifyMcpEntryPoint(dependencies);
  await verifyHookEntryPoint(codexHome, dependencies);
  await verifyRunnableEntrypoint(dependencies);
};

export const installAndVerifyCodexIntegration = async (
  codexHome: string,
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  await verifyCodexVersion(dependencies);

  // Replace a stale Coloop MCP registration, then re-read it before continuing.
  let mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  if (
    mcp.exitCode !== 0 ||
    !isExpectedMcpConfiguration(mcp.stdout, dependencies)
  ) {
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
      dependencies.coloopEntrypoint.command,
      ...dependencies.coloopEntrypoint.args,
      "mcp",
    ]);
    if (added.exitCode !== 0) {
      throw new Error("Codex MCP entry point could not be installed.");
    }
    mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  }
  if (
    mcp.exitCode !== 0 ||
    !isExpectedMcpConfiguration(mcp.stdout, dependencies)
  ) {
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
  // Replace only Coloop's matcher and preserve every hook owned by the user or another tool.
  const preToolUse = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse.filter((entry) => !matchesPreToolMatcher(entry))
    : [];
  preToolUse.push(coloopPreToolHook(dependencies));
  const userPromptSubmit = Array.isArray(hooks.UserPromptSubmit)
    ? [...hooks.UserPromptSubmit]
    : [];
  const promptHook = coloopPromptHook(dependencies);
  if (
    !userPromptSubmit.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(promptHook),
    )
  ) {
    userPromptSubmit.push(promptHook);
  }

  const nextDocument: HooksFile = {
    ...document,
    hooks: {
      ...hooks,
      PreToolUse: preToolUse,
      UserPromptSubmit: userPromptSubmit,
    },
  };
  await writeFile(hooksPath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(hooksPath, 0o600);

  await verifyCodexIntegration(codexHome, dependencies);
};
