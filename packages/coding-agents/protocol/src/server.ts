import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

interface JsonRpcRequest {
  id?: string | number;
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRequest = (line: string): JsonRpcRequest | null => {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) return null;
  const id = parsed.id;
  if (
    id !== undefined &&
    typeof id !== "string" &&
    typeof id !== "number"
  ) {
    return null;
  }
  return {
    ...(id === undefined ? {} : { id }),
    jsonrpc: parsed.jsonrpc,
    method: parsed.method,
    params: parsed.params,
  };
};

const writeMessage = (output: Writable, value: object): void => {
  output.write(`${JSON.stringify(value)}\n`);
};

const openEpisodeTool = {
  description:
    "Open a private Coloop Collaboration Episode from the approved Origin Session context.",
  inputSchema: {
    additionalProperties: true,
    properties: {
      opening_brief: { type: "string" },
    },
    required: ["opening_brief"],
    type: "object",
  },
  name: "open_episode",
};

export const runMcpServer = async (
  input: Readable,
  output: Writable,
): Promise<number> => {
  // Codex's stdio transport sends one complete JSON-RPC message per line.
  const lines = createInterface({ input, terminal: false });
  for await (const line of lines) {
    let request: JsonRpcRequest;
    try {
      const parsed = parseRequest(line);
      if (!parsed) throw new Error("invalid request");
      request = parsed;
    } catch {
      writeMessage(output, {
        error: { code: -32700, message: "Parse error" },
        id: null,
        jsonrpc: "2.0",
      });
      continue;
    }
    if (request.id === undefined) {
      // Notifications have no response by JSON-RPC definition.
      continue;
    }
    if (request.method === "initialize") {
      const params = isRecord(request.params) ? request.params : undefined;
      writeMessage(output, {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: { listChanged: false } },
          protocolVersion:
            typeof params?.protocolVersion === "string"
              ? params.protocolVersion
              : "2025-06-18",
          serverInfo: { name: "coloop", version: "0.0.0" },
        },
      });
      continue;
    }
    if (request.method === "tools/list") {
      writeMessage(output, {
        id: request.id,
        jsonrpc: "2.0",
        result: { tools: [openEpisodeTool] },
      });
      continue;
    }
    if (request.method === "tools/call") {
      const params = isRecord(request.params) ? request.params : undefined;
      if (params?.name !== "open_episode") {
        writeMessage(output, {
          error: { code: -32602, message: "Unknown tool" },
          id: request.id,
          jsonrpc: "2.0",
        });
        continue;
      }
      // Tool discovery works now, but Episode creation waits for the later runtime package.
      writeMessage(output, {
        id: request.id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              text: "Episode opening is unavailable until the Episode runtime is installed.",
              type: "text",
            },
          ],
          isError: true,
        },
      });
      continue;
    }
    if (request.method === "ping") {
      writeMessage(output, { id: request.id, jsonrpc: "2.0", result: {} });
      continue;
    }
    writeMessage(output, {
      error: { code: -32601, message: "Method not found" },
      id: request.id,
      jsonrpc: "2.0",
    });
  }
  return 0;
};
