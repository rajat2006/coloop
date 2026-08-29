import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createColoopRuntime,
  type DiscordEpisodeTransport,
} from "./runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }),
  );
});

describe("Codex Episode operations", () => {
  it("opens an approved Episode from a trusted Codex 0.150.1 session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-open-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [
        ownerMessage("Help me choose a migration plan."),
        assistantMessage("I’ll prepare a collaboration brief.", "commentary"),
        assistantMessage("Please approve opening the Episode.", "final_answer"),
      ]),
      { mode: 0o600 },
    );
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });

    const result = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief:
            "# Migration decision\n\nCompare the two safe rollout options.",
          originalRequest: "Help me choose a migration plan.",
          originSessionId: "model-authored-session",
        },
        approved: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      created: true,
      episode: {
        phase: "ACTIVE",
        originSessionId: "origin-1",
        threadUrl: "https://discord.test/channels/2002/thread-1",
      },
    });
    if (!result.ok) throw new Error(result.reason);
    if (result.episode.phase !== "ACTIVE") throw new Error("Expected an active Episode.");
    expect(discord.effects).toEqual([
      {
        kind: "create_private_thread",
        guildId: "2002",
        parentChannelId: "3003",
        ownerDiscordUserId: "1001",
        episodeId: result.episode.id,
      },
      {
        kind: "post_opening_brief",
        threadId: "thread-1",
        markdown: "# Migration decision\n\nCompare the two safe rollout options.",
      },
      {
        kind: "show_collaborator_selector",
        threadId: "thread-1",
        maximumSelections: 25,
      },
    ]);
    expect(await readFile(result.episode.contextPackage.reference, "utf8")).toBe(
      "# Collaboration Episode Context\n\n" +
        "## Owner\n\nHelp me choose a migration plan.\n\n" +
        "## Codex commentary\n\nI’ll prepare a collaboration brief.\n\n" +
        "## Codex final\n\nPlease approve opening the Episode.\n",
    );
    expect((await stat(result.episode.contextPackage.reference)).mode & 0o777).toBe(
      0o400,
    );
    runtime.close();
  });

  it("retrieves and cancels only from the bound Origin Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-cancel-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Review the rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review\n\nIdentify rollout risks.",
          originalRequest: "Review the rollout plan.",
        },
        approved: true,
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("another-origin", transcriptPath),
        request: {
          operation: "get_episode",
          arguments: { episodeId: opened.episode.id },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "EPISODE_NOT_FOUND",
      reason: "No Episode is available to this Origin Session.",
    });
    const cancelled = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      request: {
        operation: "cancel_episode",
        arguments: { episodeId: opened.episode.id, reason: "Scope changed." },
        approved: true,
      },
    });

    expect(cancelled).toEqual({
      ok: true,
      episode: {
        id: opened.episode.id,
        phase: "CANCELLED",
        cancellation: {
          cancelledAt: "2026-08-29T12:00:00.000Z",
          reason: "Scope changed.",
        },
      },
    });
    expect(discord.effects.at(-1)).toEqual({
      kind: "present_cancellation",
      guildId: "2002",
      threadId: "thread-1",
      episodeId: opened.episode.id,
      reason: "Scope changed.",
      controlsDisabled: true,
      threadWritable: true,
    });
    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath),
        request: {
          operation: "cancel_episode",
          arguments: { episodeId: opened.episode.id, reason: "Different replay." },
          approved: true,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "REPLAY_INPUT_MISMATCH",
      reason: "The trusted operation identity was reused with different input.",
    });
    runtime.close();
  });

  it("fails closed for an unknown MCP operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-unknown-"));
    temporaryDirectories.push(directory);
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord: new RecordingDiscordTransport(),
    });

    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", join(directory, "rollout.jsonl")),
        request: { operation: "delete_episode", arguments: {} },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "INVALID_OPERATION",
      reason: "The Codex Episode operation is unsupported or malformed.",
    });
    runtime.close();
  });

  it("returns the existing Episode without recapturing context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-reopen-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Ask the team for input.")]),
    );
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
    });
    const first = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# First brief\n\nDiscuss the plan.",
          originalRequest: "Ask the team for input.",
        },
        approved: true,
      },
    });
    if (!first.ok) throw new Error(first.reason);

    const retry = await runtime.handleCodexOperation({
      hook: {
        ...trustedHook("origin-1", join(directory, "missing.jsonl")),
        turnId: "turn-2",
        toolUseId: "tool-use-2",
      },
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Replacement brief\n\nThis must not be used.",
          originalRequest: "A replacement request.",
        },
        approved: true,
      },
    });

    expect(retry).toMatchObject({
      ok: true,
      created: false,
      episode: { id: first.episode.id, phase: "ACTIVE" },
    });
    expect(discord.effects).toHaveLength(3);
    runtime.close();
  });

  it("blocks high-confidence credentials before creating Discord effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-secret-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    const request = "Check this token sk-abcdefghijklmnopqrstuvwxyz123456 with the team.";
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage(request)]),
    );
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
    });

    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath),
        request: {
          operation: "open_episode",
          arguments: { openingBrief: "# Review\n\nCheck the credential.", originalRequest: request },
          approved: true,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "CREDENTIAL_DETECTED",
      reason: "Opening blocked: remove the credential-like value sk-…3456.",
    });
    expect(discord.effects).toEqual([]);
    runtime.close();
  });

  it("fails closed outside the supported Codex client and transcript contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-contract-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [
        ownerMessage("Ask for input."),
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "analysis",
            content: [{ type: "output_text", text: "Hidden reasoning." }],
          },
        },
      ]),
    );
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord: new RecordingDiscordTransport(),
    });
    const request = {
      operation: "open_episode",
      arguments: { openingBrief: "# Input", originalRequest: "Ask for input." },
      approved: true,
    };

    await expect(
      runtime.handleCodexOperation({
        hook: { ...trustedHook("origin-1", transcriptPath), clientVersion: "0.151.0" },
        request,
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_CODEX_CLIENT" });
    await expect(
      runtime.handleCodexOperation({ hook: trustedHook("origin-1", transcriptPath), request }),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_TRANSCRIPT" });
    runtime.close();
  });
});

function trustedHook(sessionId: string, transcriptPath: string) {
  return {
    event: "PreToolUse" as const,
    client: "codex-cli" as const,
    clientVersion: "0.150.1" as const,
    sessionId,
    turnId: "turn-1",
    toolUseId: "tool-use-1",
    transcriptPath,
  };
}

function fixtureTranscript(sessionId: string, records: readonly object[]): string {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, source: "cli" },
    }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1" } }),
    ...records.map((record) => JSON.stringify(record)),
  ].join("\n");
}

function ownerMessage(text: string): object {
  return { type: "event_msg", payload: { type: "user_message", message: text } };
}

function assistantMessage(
  text: string,
  phase: "commentary" | "final_answer",
): object {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase,
      content: [{ type: "output_text", text }],
    },
  };
}

class RecordingDiscordTransport implements DiscordEpisodeTransport {
  readonly effects: object[] = [];

  async provisionEpisode(input: {
    readonly guildId: string;
    readonly parentChannelId: string;
    readonly ownerDiscordUserId: string;
    readonly episodeId: string;
    readonly openingBrief: string;
  }) {
    this.effects.push({
      kind: "create_private_thread",
      guildId: input.guildId,
      parentChannelId: input.parentChannelId,
      ownerDiscordUserId: input.ownerDiscordUserId,
      episodeId: input.episodeId,
    });
    this.effects.push({
      kind: "post_opening_brief",
      threadId: "thread-1",
      markdown: input.openingBrief,
    });
    this.effects.push({
      kind: "show_collaborator_selector",
      threadId: "thread-1",
      maximumSelections: 25,
    });
    return {
      threadId: "thread-1",
      threadUrl: "https://discord.test/channels/2002/thread-1",
    };
  }

  async presentCancellation(input: {
    readonly guildId: string;
    readonly threadId: string;
    readonly episodeId: string;
    readonly reason?: string;
  }): Promise<void> {
    this.effects.push({
      kind: "present_cancellation",
      ...input,
      controlsDisabled: true,
      threadWritable: true,
    });
  }
}
