import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerCodexEpisodeTools,
  type EpisodeToolRegistrar,
  type TrustedCodexInvocation,
} from "./mcp";
import {
  createOwnerApproval,
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
    const transcriptPath = fileURLToPath(
      new URL("./fixtures/codex-cli-0.150.1-rollout.jsonl", import.meta.url),
    );
    const hookPayload = JSON.parse(
      await readFile(
        new URL("./fixtures/codex-cli-0.150.1-pre-tool-use.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    if (typeof hookPayload !== "object" || hookPayload === null) {
      throw new Error("Invalid hook fixture.");
    }
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

    const approval = createOwnerApproval({
        toolUseId: "tool-use-1",
        operation: "open_episode",
        openingBrief: "# Migration decision\n\nCompare the two safe rollout options.",
        originalRequest: "Help me choose a migration plan.",
        contextMarkdown:
          "# Collaboration Episode Context\n\n" +
          "## Owner\n\nHelp me choose a migration plan.\n\n" +
          "## Codex commentary\n\nI’ll prepare a collaboration brief.\n\n" +
          "## Codex final\n\nPlease approve opening the Episode.\n",
      });
    const mcp = new RecordingEpisodeToolRegistrar();
    registerCodexEpisodeTools(mcp, runtime);
    const result = await mcp.call(
      "open_episode",
      {
        openingBrief: "# Migration decision\n\nCompare the two safe rollout options.",
        originalRequest: "Help me choose a migration plan.",
        originSessionId: "model-authored-session",
      },
      {
        hook: {
          client: { name: "codex-cli", version: "0.150.1" },
          payload: { ...hookPayload, transcript_path: transcriptPath },
        },
        approval,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      created: true,
      episode: {
        phase: "ACTIVE",
        originSessionId: "origin-1",
        collaborationUrl: "https://discord.test/channels/2002/thread-1",
      },
    });
    if (!result.ok) throw new Error(result.reason);
    if (result.episode.phase !== "ACTIVE") throw new Error("Expected an active Episode.");
    expect(discord.effects).toEqual([
      {
        kind: "create_private_thread",
        idempotencyKey: `episode-opened:${result.episode.id}`,
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
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Review\n\nIdentify rollout risks.",
        "Review the rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review\n\nIdentify rollout risks.",
          originalRequest: "Review the rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("another-origin", transcriptPath, "get_episode"),
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
      hook: trustedHook("origin-1", transcriptPath, "cancel_episode"),
      approval: createOwnerApproval({
        toolUseId: "tool-use-1",
        operation: "cancel_episode",
        episodeId: opened.episode.id,
        reason: "Scope changed.",
      }),
      request: {
        operation: "cancel_episode",
        arguments: { episodeId: opened.episode.id, reason: "Scope changed." },
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
      idempotencyKey: `episode-cancelled:${opened.episode.id}`,
      guildId: "2002",
      threadId: "thread-1",
      episodeId: opened.episode.id,
      reason: "Scope changed.",
      controlsDisabled: true,
      threadWritable: true,
    });
    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath, "cancel_episode"),
        approval: createOwnerApproval({
          toolUseId: "tool-use-1",
          operation: "cancel_episode",
          episodeId: opened.episode.id,
          reason: "Different replay.",
        }),
        request: {
          operation: "cancel_episode",
          arguments: { episodeId: opened.episode.id, reason: "Different replay." },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "REPLAY_INPUT_MISMATCH",
      reason: "The trusted operation identity was reused with different input.",
    });
    runtime.close();
  });

  it("retrieves an Episode without changing durable provider state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-get-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "coloop.sqlite");
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Review the rollout plan.")]),
    );
    const runtime = createColoopRuntime({
      databasePath,
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord: new RecordingDiscordTransport(),
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Review\n\nIdentify rollout risks.",
        "Review the rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review\n\nIdentify rollout risks.",
          originalRequest: "Review the rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath, "get_episode"),
        request: {
          operation: "get_episode",
          arguments: { episodeId: opened.episode.id },
        },
      }),
    ).resolves.toMatchObject({ ok: true, episode: { id: opened.episode.id } });
    runtime.close();

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare("SELECT effect_kind FROM provider_inbox ORDER BY received_at")
        .all(),
    ).toEqual([{ effect_kind: "open_episode" }]);
    database.close();
  });

  it("requires Owner approval for opening and cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-approval-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Request input.")]),
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
    const openingRequest = {
      operation: "open_episode",
      arguments: { openingBrief: "# Input", originalRequest: "Request input." },
    };
    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath),
        request: openingRequest,
      }),
    ).resolves.toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(discord.effects).toEqual([]);

    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen("tool-use-1", "# Input", "Request input."),
      request: openingRequest,
    });
    if (!opened.ok) throw new Error(opened.reason);
    await expect(
      runtime.handleCodexOperation({
        hook: {
          ...trustedHook("origin-1", transcriptPath, "cancel_episode"),
          payload: {
            ...trustedHook("origin-1", transcriptPath, "cancel_episode").payload,
            tool_use_id: "tool-use-3",
          },
        },
        request: {
          operation: "cancel_episode",
          arguments: { episodeId: opened.episode.id },
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(discord.effects).toHaveLength(3);
    runtime.close();
  });

  it("keeps an Episode OPENING when Discord provisioning fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-provision-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Request input.")]),
    );
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord: new RecordingDiscordTransport(true),
    });

    const result = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen("tool-use-1", "# Input", "Request input."),
      request: {
        operation: "open_episode",
        arguments: { openingBrief: "# Input", originalRequest: "Request input." },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "DISCORD_PROVISIONING_FAILED",
      reason: expect.stringContaining("remains OPENING"),
    });
    runtime.close();
  });

  it("presents cancellation when it wins during Discord provisioning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-provision-cancel-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "coloop.sqlite");
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Request input.")]),
    );
    const discord = new DeferredDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath,
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      createId: () => "episode-1",
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });

    const opening = runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen("tool-use-1", "# Input", "Request input."),
      request: {
        operation: "open_episode",
        arguments: { openingBrief: "# Input", originalRequest: "Request input." },
      },
    });
    await discord.provisionStarted;
    const cancellationHook = trustedHook(
      "origin-1",
      transcriptPath,
      "cancel_episode",
    );
    const hook = {
      ...cancellationHook,
      payload: { ...cancellationHook.payload, tool_use_id: "tool-use-2" },
    };
    await expect(
      runtime.handleCodexOperation({
        hook,
        approval: createOwnerApproval({
          toolUseId: "tool-use-2",
          operation: "cancel_episode",
          episodeId: "episode-1",
          reason: "No longer needed.",
        }),
        request: {
          operation: "cancel_episode",
          arguments: { episodeId: "episode-1", reason: "No longer needed." },
        },
      }),
    ).resolves.toMatchObject({ ok: true, episode: { phase: "CANCELLED" } });

    discord.finishProvisioning();
    await expect(opening).resolves.toMatchObject({
      ok: true,
      episode: { phase: "CANCELLED" },
    });
    expect(discord.effects.at(-1)).toMatchObject({
      kind: "present_cancellation",
      episodeId: "episode-1",
      threadId: "thread-1",
    });
    runtime.close();

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare("SELECT transition_type FROM episode_audit ORDER BY occurred_at, rowid")
        .all(),
    ).toEqual([
      { transition_type: "EPISODE_OPENING" },
      { transition_type: "EPISODE_CANCELLED" },
    ]);
    database.close();
  });

  it("requires the approved original request to match the trusted transcript", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-question-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Trusted request.")]),
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
        approval: createOwnerApproval({
          toolUseId: "tool-use-1",
          operation: "open_episode",
          openingBrief: "# Input",
          originalRequest: "Model replacement.",
          contextMarkdown:
            "# Collaboration Episode Context\n\n## Owner\n\nTrusted request.\n",
        }),
        request: {
          operation: "open_episode",
          arguments: { openingBrief: "# Input", originalRequest: "Model replacement." },
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "ORIGINAL_REQUEST_MISMATCH" });
    expect(discord.effects).toEqual([]);
    runtime.close();
  });

  it("retries pending Discord cancellation presentation from the outbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-cancel-retry-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Request input.")]),
    );
    const discord = new RecordingDiscordTransport(false, true);
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen("tool-use-1", "# Input", "Request input."),
      request: {
        operation: "open_episode",
        arguments: { openingBrief: "# Input", originalRequest: "Request input." },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);
    const hook = {
      ...trustedHook("origin-1", transcriptPath, "cancel_episode"),
      payload: {
        ...trustedHook("origin-1", transcriptPath, "cancel_episode").payload,
        tool_use_id: "tool-use-2",
      },
    };
    const approval = createOwnerApproval({
      toolUseId: "tool-use-2",
      operation: "cancel_episode",
      episodeId: opened.episode.id,
      reason: "No longer needed.",
    });
    const request = {
      operation: "cancel_episode",
      arguments: { episodeId: opened.episode.id, reason: "No longer needed." },
    };

    await expect(
      runtime.handleCodexOperation({ hook, approval, request }),
    ).resolves.toMatchObject({ ok: false, code: "DISCORD_PRESENTATION_FAILED" });
    await expect(
      runtime.handleCodexOperation({ hook, approval, request }),
    ).resolves.toMatchObject({ ok: true, episode: { phase: "CANCELLED" } });
    expect(
      discord.effects.filter((effect) =>
        "kind" in effect ? effect.kind === "present_cancellation" : false,
      ),
    ).toHaveLength(1);
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
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# First brief\n\nDiscuss the plan.",
        "Ask the team for input.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# First brief\n\nDiscuss the plan.",
          originalRequest: "Ask the team for input.",
        },
      },
    });
    if (!first.ok) throw new Error(first.reason);

    const retry = await runtime.handleCodexOperation({
      hook: {
        ...trustedHook("origin-1", join(directory, "missing.jsonl")),
        payload: {
          ...trustedHook("origin-1", join(directory, "missing.jsonl")).payload,
          turn_id: "turn-2",
          tool_use_id: "tool-use-2",
        },
      },
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Replacement brief\n\nThis must not be used.",
          originalRequest: "A replacement request.",
        },
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
        approval: approveOwnerOnlyOpen(
          "tool-use-1",
          "# Review\n\nCheck the credential.",
          request,
        ),
        request: {
          operation: "open_episode",
          arguments: { openingBrief: "# Review\n\nCheck the credential.", originalRequest: request },
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
    };

    await expect(
      runtime.handleCodexOperation({
        hook: {
          ...trustedHook("origin-1", transcriptPath),
          client: { name: "codex-cli", version: "0.151.0" },
        },
        request,
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_CODEX_CLIENT" });
    await expect(
      runtime.handleCodexOperation({ hook: trustedHook("origin-1", transcriptPath), request }),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_TRANSCRIPT" });
    const unsupportedVisibleRecords = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [
            { type: "output_text", text: "One" },
            { type: "output_text", text: "Two" },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_image", image_url: "https://example.invalid/image" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "unknown_role",
          phase: "commentary",
          content: [{ type: "output_text", text: "Unknown" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          provenance: "external",
          message: "Not Owner-authored.",
        },
      },
    ];
    for (const record of unsupportedVisibleRecords) {
      await writeFile(
        transcriptPath,
        fixtureTranscript("origin-1", [ownerMessage("Ask for input."), record]),
      );
      await expect(
        runtime.handleCodexOperation({ hook: trustedHook("origin-1", transcriptPath), request }),
      ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_TRANSCRIPT" });
    }
    runtime.close();
  });
});

function trustedHook(
  sessionId: string,
  transcriptPath: string,
  operation: "open_episode" | "get_episode" | "cancel_episode" = "open_episode",
) {
  return {
    client: { name: "codex-cli" as const, version: "0.150.1" as const },
    payload: {
      hook_event_name: "PreToolUse" as const,
      session_id: sessionId,
      turn_id: "turn-1",
      tool_use_id: "tool-use-1",
      tool_name: `mcp__coloop__${operation}`,
      transcript_path: transcriptPath,
      tool_input: {},
    },
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
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "tool-use-1",
        name: "mcp__coloop__open_episode",
        arguments: "{}",
      },
    }),
  ].join("\n");
}

function ownerMessage(text: string): object {
  return { type: "event_msg", payload: { type: "user_message", message: text } };
}

function approveOwnerOnlyOpen(
  toolUseId: string,
  openingBrief: string,
  originalRequest: string,
): object {
  return createOwnerApproval({
    toolUseId,
    operation: "open_episode",
    openingBrief,
    originalRequest,
    contextMarkdown:
      `# Collaboration Episode Context\n\n## Owner\n\n${originalRequest}\n`,
  });
}

class RecordingDiscordTransport implements DiscordEpisodeTransport {
  readonly effects: object[] = [];

  constructor(
    private readonly failProvisioning = false,
    private failCancellationOnce = false,
  ) {}

  async provisionEpisode(
    input: Parameters<DiscordEpisodeTransport["provisionEpisode"]>[0],
  ) {
    if (this.failProvisioning) throw new Error("Discord unavailable");
    this.effects.push({
      kind: "create_private_thread",
      idempotencyKey: input.idempotencyKey,
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

  async presentCancellation(
    input: Parameters<DiscordEpisodeTransport["presentCancellation"]>[0],
  ): Promise<void> {
    if (this.failCancellationOnce) {
      this.failCancellationOnce = false;
      throw new Error("Discord unavailable");
    }
    this.effects.push({
      kind: "present_cancellation",
      ...input,
      controlsDisabled: true,
      threadWritable: true,
    });
  }
}

class DeferredDiscordTransport implements DiscordEpisodeTransport {
  readonly effects: object[] = [];
  readonly provisionStarted: Promise<void>;
  private finishProvisioningPromise: Promise<void>;
  private resolveFinishProvisioning!: () => void;
  private resolveProvisionStarted!: () => void;

  constructor() {
    this.provisionStarted = new Promise((resolve) => {
      this.resolveProvisionStarted = resolve;
    });
    this.finishProvisioningPromise = new Promise((resolve) => {
      this.resolveFinishProvisioning = resolve;
    });
  }

  async provisionEpisode(
    input: Parameters<DiscordEpisodeTransport["provisionEpisode"]>[0],
  ): Promise<{ readonly threadId: string; readonly threadUrl: string }> {
    this.effects.push({ kind: "create_private_thread", episodeId: input.episodeId });
    this.resolveProvisionStarted();
    await this.finishProvisioningPromise;
    return {
      threadId: "thread-1",
      threadUrl: "https://discord.test/channels/2002/thread-1",
    };
  }

  finishProvisioning(): void {
    this.resolveFinishProvisioning();
  }

  async presentCancellation(
    input: Parameters<DiscordEpisodeTransport["presentCancellation"]>[0],
  ): Promise<void> {
    this.effects.push({ kind: "present_cancellation", ...input });
  }
}

class RecordingEpisodeToolRegistrar implements EpisodeToolRegistrar {
  private readonly handlers = new Map<
    string,
    (arguments_: unknown, trusted: TrustedCodexInvocation) => Promise<unknown>
  >();

  registerTool(
    definition: Parameters<EpisodeToolRegistrar["registerTool"]>[0],
    invoke: Parameters<EpisodeToolRegistrar["registerTool"]>[1],
  ): void {
    this.handlers.set(definition.name, invoke);
  }

  async call(
    name: Parameters<EpisodeToolRegistrar["registerTool"]>[0]["name"],
    arguments_: unknown,
    trusted: TrustedCodexInvocation,
  ) {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new Error(`Tool ${name} is not registered.`);
    return handler(arguments_, trusted) as ReturnType<
      Parameters<EpisodeToolRegistrar["registerTool"]>[1]
    >;
  }
}
