import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmptyResult } from "@coloop/core";

export type CommandResult =
  | { readonly ok: true; readonly stderr: string; readonly stdout: string }
  | {
      readonly exitCode: number;
      readonly ok: false;
      readonly reason: "command-failed";
      readonly stderr: string;
      readonly stdout: string;
    };

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasErrorCode = (value: unknown, code: string): boolean =>
  isRecord(value) && value.code === code;

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
  if (!version.ok || version.stdout.trim() !== supportedCodexVersion) {
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
    const configuration: unknown = JSON.parse(stdout);
    if (!isRecord(configuration) || !isRecord(configuration.transport)) {
      return false;
    }
    const transport = configuration.transport;
    return (
      configuration.name === "coloop" &&
      configuration.enabled === true &&
      transport.type === "stdio" &&
      transport.command === dependencies.coloopEntrypoint.command &&
      Array.isArray(transport.args) &&
      JSON.stringify(transport.args) ===
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
  if (!mcp.ok || !isExpectedMcpConfiguration(mcp.stdout, dependencies)) {
    throw new Error("Codex MCP entry point could not be verified.");
  }
};

const verifyHookEntryPoint = async (
  codexHome: string,
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  try {
    const hooksPath = join(codexHome, "hooks.json");
    const parsed: unknown = JSON.parse(await readFile(hooksPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("invalid hooks document");
    const verified: HooksFile = parsed;
    const hooks = isRecord(verified.hooks) ? verified.hooks : undefined;
    if (
      !containsColoopHook(hooks?.PreToolUse, dependencies) ||
      !containsPromptHook(hooks?.UserPromptSubmit, dependencies)
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
  if (!result.ok) {
    throw new Error("Coloop executable entry point could not be verified.");
  }
};

export const verifyCodexIntegration = async (
  codexHome: string,
  dependencies: CodexIntegrationDependencies,
): Promise<EmptyResult<"codex-integration-invalid">> => {
  try {
    // Runtime verification is intentionally read-only; setup owns all repairs.
    await verifyCodexVersion(dependencies);
    await verifyMcpEntryPoint(dependencies);
    await verifyHookEntryPoint(codexHome, dependencies);
    await verifyRunnableEntrypoint(dependencies);
    return { ok: true };
  } catch {
    return { ok: false, reason: "codex-integration-invalid" };
  }
};

export const installAndVerifyCodexIntegration = async (
  codexHome: string,
  dependencies: CodexIntegrationDependencies,
): Promise<void> => {
  await verifyCodexVersion(dependencies);

  // Replace a stale Coloop MCP registration, then re-read it before continuing.
  let mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  if (
    !mcp.ok ||
    !isExpectedMcpConfiguration(mcp.stdout, dependencies)
  ) {
    if (mcp.ok) {
      const removed = await dependencies.runCodex(["mcp", "remove", "coloop"]);
      if (!removed.ok) {
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
    if (!added.ok) {
      throw new Error("Codex MCP entry point could not be installed.");
    }
    mcp = await dependencies.runCodex(["mcp", "get", "--json", "coloop"]);
  }
  if (
    !mcp.ok ||
    !isExpectedMcpConfiguration(mcp.stdout, dependencies)
  ) {
    throw new Error("Codex MCP entry point could not be verified.");
  }

  await mkdir(codexHome, { mode: 0o700, recursive: true });
  await chmod(codexHome, 0o700);
  const hooksPath = join(codexHome, "hooks.json");
  let document: HooksFile = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksPath, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("invalid hooks document");
    }
    document = parsed;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
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

  const verification = await verifyCodexIntegration(codexHome, dependencies);
  if (!verification.ok) {
    throw new Error("Codex integration could not be verified after installation.");
  }
};
