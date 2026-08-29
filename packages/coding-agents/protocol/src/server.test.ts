import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { runMcpServer } from "./server.js";

class StringWriter extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

describe("coding-agent protocol", () => {
  test("the MCP stdio entry point completes initialization", async () => {
    const output = new StringWriter();
    const exitCode = await runMcpServer(
      Readable.from([
        `${JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        })}\n`,
        `${JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" })}\n`,
      ]),
      output,
    );

    expect(exitCode).toBe(0);
    const responses = output.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toEqual([
      {
        id: 1,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: { listChanged: false } },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "coloop", version: "0.0.0" },
        },
      },
      {
        id: 2,
        jsonrpc: "2.0",
        result: {
          tools: [expect.objectContaining({ name: "open_episode" })],
        },
      },
    ]);
  });
});
