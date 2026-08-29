import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCodexHook } from "../src/hooks.js";
import { runMcpServer } from "../src/mcp.js";

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

describe("Codex CLI integration entry points", () => {
  test("the pre-tool hook replaces model-authored origin identity with trusted hook identity", async () => {
    const output = new StringWriter();
    const error = new StringWriter();
    const exitCode = await runCodexHook(
      "pre-tool-use",
      Readable.from([
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "trusted-session",
          tool_input: {
            opening_brief: "Please review this bounded question.",
            _origin_session_id: "model-authored-session",
            _origin_transcript_path: "/untrusted/transcript.jsonl",
            _origin_turn_id: "model-authored-turn",
          },
          tool_name: "mcp__coloop__open_episode",
          transcript_path: "/trusted/transcript.jsonl",
          turn_id: "trusted-turn",
        }),
      ]),
      output,
      error,
    );

    expect(exitCode).toBe(0);
    expect(error.value).toBe("");
    const response = JSON.parse(output.value) as {
      hookSpecificOutput: { updatedInput: Record<string, unknown> };
    };
    expect(response.hookSpecificOutput.updatedInput).toEqual({
      _origin_session_id: "trusted-session",
      _origin_transcript_path: "/trusted/transcript.jsonl",
      _origin_turn_id: "trusted-turn",
      opening_brief: "Please review this bounded question.",
    });
  });

  test("the pre-tool hook rejects empty trusted identity fields", async () => {
    const output = new StringWriter();
    const error = new StringWriter();
    const exitCode = await runCodexHook(
      "pre-tool-use",
      Readable.from([
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "",
          tool_input: {},
          tool_name: "mcp__coloop__open_episode",
          transcript_path: "/trusted/transcript.jsonl",
          turn_id: "trusted-turn",
        }),
      ]),
      output,
      error,
    );

    expect(exitCode).toBe(2);
    expect(output.value).toBe("");
  });

  test("the pre-tool hook fails closed for unsupported identity payloads", async () => {
    const output = new StringWriter();
    const error = new StringWriter();
    const exitCode = await runCodexHook(
      "pre-tool-use",
      Readable.from([
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "trusted-session",
          tool_input: {},
          tool_name: "mcp__coloop__open_episode",
          transcript_path: null,
          turn_id: "trusted-turn",
        }),
      ]),
      output,
      error,
    );

    expect(exitCode).toBe(2);
    expect(output.value).toBe("");
    expect(error.value).toBe(
      "Coloop blocked an unsupported Codex hook payload.\n",
    );
  });

  test("the next-prompt hook rejects unsupported Codex payloads", async () => {
    const output = new StringWriter();
    const error = new StringWriter();
    const exitCode = await runCodexHook(
      "user-prompt-submit",
      Readable.from([JSON.stringify({ hook_event_name: "UnknownPromptEvent" })]),
      output,
      error,
    );

    expect(exitCode).toBe(2);
    expect(output.value).toBe("");
    expect(error.value).toBe(
      "Coloop blocked an unsupported Codex hook payload.\n",
    );
  });

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
          tools: [
            expect.objectContaining({ name: "open_episode" }),
          ],
        },
      },
    ]);
  });
});
