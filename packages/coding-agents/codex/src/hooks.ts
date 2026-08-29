import type { Readable, Writable } from "node:stream";

const readInput = async (input: Readable): Promise<string> => {
  let body = "";
  for await (const chunk of input) {
    body += chunk.toString();
    if (body.length > 1_000_000) {
      throw new Error("hook_input_too_large");
    }
  }
  return body;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const runCodexHook = async (
  hook: string | undefined,
  input: Readable,
  output: Writable,
  error: Writable,
): Promise<number> => {
  if (hook !== "pre-tool-use" && hook !== "user-prompt-submit") {
    error.write("Unsupported Coloop Codex hook.\n");
    return 2;
  }

  try {
    const event = JSON.parse(await readInput(input)) as Record<string, unknown>;
    if (hook === "user-prompt-submit") {
      // This hook validates the next-prompt context but does not modify it.
      if (
        event.hook_event_name !== "UserPromptSubmit" ||
        !isNonEmptyString(event.session_id) ||
        !isNonEmptyString(event.turn_id) ||
        typeof event.prompt !== "string"
      ) {
        throw new Error("unsupported_hook_shape");
      }
      return 0;
    }
    if (
      event.hook_event_name !== "PreToolUse" ||
      event.tool_name !== "mcp__coloop__open_episode" ||
      !isNonEmptyString(event.session_id) ||
      !isNonEmptyString(event.turn_id) ||
      !isNonEmptyString(event.transcript_path) ||
      typeof event.tool_input !== "object" ||
      event.tool_input === null ||
      Array.isArray(event.tool_input)
    ) {
      throw new Error("unsupported_hook_shape");
    }
    // Trusted Codex fields replace any model-authored origin fields in the tool input.
    output.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            ...(event.tool_input as Record<string, unknown>),
            _origin_session_id: event.session_id,
            _origin_transcript_path: event.transcript_path,
            _origin_turn_id: event.turn_id,
          },
        },
      })}\n`,
    );
    return 0;
  } catch {
    // Hook validation fails closed so unsupported payloads cannot open an Episode.
    error.write("Coloop blocked an unsupported Codex hook payload.\n");
    return 2;
  }
};
