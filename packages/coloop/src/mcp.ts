import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

interface JsonRpcRequest {
  id?: string | number;
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
}

const writeMessage = (output: Writable, value: object): void => {
  output.write(`${JSON.stringify(value)}\n`);
};

export const runMcpServer = async (
  input: Readable,
  output: Writable,
): Promise<number> => {
  const lines = createInterface({ input, terminal: false });
  for await (const line of lines) {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeMessage(output, {
        error: { code: -32700, message: "Parse error" },
        id: null,
        jsonrpc: "2.0",
      });
      continue;
    }
    if (request.id === undefined) {
      continue;
    }
    if (request.method === "initialize") {
      const params = request.params as { protocolVersion?: unknown } | undefined;
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
        result: { tools: [] },
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
