import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export class Terminal {
  readonly #closed: Promise<void>;
  readonly #lines: string[] = [];
  readonly #output: Writable;
  readonly #readers: Array<(line: string | null) => void> = [];
  #didClose = false;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    const readline = createInterface({ input, terminal: false });
    this.#closed = new Promise((resolve) => {
      readline.on("close", () => {
        this.#didClose = true;
        for (const reader of this.#readers.splice(0)) {
          reader(null);
        }
        resolve();
      });
    });
    readline.on("line", (line) => {
      const reader = this.#readers.shift();
      if (reader) {
        reader(line);
      } else {
        this.#lines.push(line);
      }
    });
  }

  line(message = ""): void {
    this.#output.write(`${message}\n`);
  }

  async ask(message: string): Promise<string> {
    this.#output.write(message);
    const available = this.#lines.shift();
    if (available !== undefined) {
      return available.trim();
    }
    if (this.#didClose) {
      return "";
    }
    return await new Promise<string>((resolve) => {
      this.#readers.push((line) => resolve(line?.trim() ?? ""));
    });
  }

  async confirm(message: string): Promise<boolean> {
    const answer = (await this.ask(`${message} [y/N] `)).toLowerCase();
    return answer === "y" || answer === "yes";
  }

  async dispose(): Promise<void> {
    await this.#closed;
  }
}
