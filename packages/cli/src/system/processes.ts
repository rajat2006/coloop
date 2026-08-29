import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CommandInvocation,
  CommandResult,
} from "@coloop/coding-agent-codex";
import { sanitizedSubprocessEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const runCodex = async (args: string[]): Promise<CommandResult> => {
  try {
    const result = await execFileAsync("codex", args, {
      encoding: "utf8",
      env: sanitizedSubprocessEnvironment(),
      timeout: 15_000,
    });
    return { ok: true, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    // Normalize spawn failures and non-zero exits into the same result shape.
    const failure = isRecord(error) ? error : {};
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      ok: false,
      reason: "command-failed",
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
        const result: CommandResult = error
          ? {
              exitCode: typeof error.code === "number" ? error.code : 1,
              ok: false,
              reason: "command-failed",
              stderr,
              stdout,
            }
          : { ok: true, stderr, stdout };
        resolve(result);
      },
    );
    child.stdin?.end(input);
  });
