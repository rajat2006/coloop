import type { ColoopDependencies } from "./dependencies.js";
import { runSetup } from "./setup.js";
import { Terminal } from "./terminal.js";
import type { Readable, Writable } from "node:stream";
import { runRuntime } from "./runtime.js";

export interface CliIo {
  error: Writable;
  input: Readable;
  output: Writable;
}

export const runCli = async (
  args: string[],
  dependencies: ColoopDependencies,
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIo = {
    error: process.stderr,
    input: process.stdin,
    output: process.stdout,
  },
): Promise<number> => {
  const terminal = new Terminal(io.input, io.output);
  try {
    const [command, ...rest] = args;
    if (rest.length > 0 || (command !== "setup" && command !== "run")) {
      io.error.write("Usage: coloop <setup|run>\n");
      return 2;
    }
    if (command === "setup") {
      await runSetup(dependencies, terminal, environment);
    } else {
      await runRuntime(dependencies, terminal, environment);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Coloop failed safely.";
    io.error.write(`${message}\n`);
    return 1;
  }
};
