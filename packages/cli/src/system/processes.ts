import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CommandInvocation,
  CommandResult,
} from "@coloop/coding-agent-codex";
import { sanitizedSubprocessEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);

export const runCodex = async (args: string[]): Promise<CommandResult> => {
  try {
    const result = await execFileAsync("codex", args, {
      encoding: "utf8",
      env: sanitizedSubprocessEnvironment(),
      timeout: 15_000,
    });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    // Normalize spawn failures and non-zero exits into the same result shape.
    const failure = error as {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    };
  }
};

export const runColoop = async (
  entrypoint: CommandInvocation,
  args: string[],
  input: string,
): Promise<CommandResult> =>
  await new Promise((resolve) => {
    const child = execFile(
      entrypoint.command,
      [...entrypoint.args, ...args],
      {
        encoding: "utf8",
        env: sanitizedSubprocessEnvironment(),
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : 1
            : 0,
          stderr,
          stdout,
        });
      },
    );
    child.stdin?.end(input);
  });
