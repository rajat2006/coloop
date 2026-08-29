import type { CodexEpisodeRuntime, EpisodeOperationResult } from "./runtime";
import {
  episodeToolInputSchemas,
  type EpisodeToolName,
} from "./codex-episode-contract";

export interface TrustedCodexInvocation {
  readonly hook: unknown;
  readonly approval?: unknown;
}

export interface EpisodeToolRegistrar {
  registerTool(
    definition: {
      readonly name: EpisodeToolName;
      readonly description: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
    },
    invoke: (
      arguments_: unknown,
      trusted: TrustedCodexInvocation,
    ) => Promise<EpisodeOperationResult>,
  ): void;
}

const toolDefinitions = [
  {
    name: "open_episode",
    description: "Open the one Owner-approved Collaboration Episode for this Origin Session.",
    inputSchema: episodeToolInputSchemas.open_episode,
  },
  {
    name: "get_episode",
    description: "Get an Episode that belongs to this trusted Origin Session.",
    inputSchema: episodeToolInputSchemas.get_episode,
  },
  {
    name: "cancel_episode",
    description: "Cancel an OPENING or ACTIVE Episode after exact Owner approval.",
    inputSchema: episodeToolInputSchemas.cancel_episode,
  },
] as const;

export function registerCodexEpisodeTools(
  registrar: EpisodeToolRegistrar,
  runtime: CodexEpisodeRuntime,
): void {
  for (const definition of toolDefinitions) {
    registrar.registerTool(definition, (arguments_, trusted) =>
      runtime.handleCodexOperation({
        hook: trusted.hook,
        request: { operation: definition.name, arguments: arguments_ },
        ...(trusted.approval === undefined ? {} : { approval: trusted.approval }),
      }),
    );
  }
}
