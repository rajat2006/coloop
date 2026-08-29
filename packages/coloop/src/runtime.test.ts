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
  createCodexPromptReturner,
  createColoopRuntime,
  type DiscordMessageEvent,
  type DiscordEpisodeTransport,
  type EpisodeAgentTransport,
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
  it("returns a finalized Outcome on the Origin Session's next prompt", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    const pending = new DatabaseSync(fixture.databasePath);
    expect(
      pending.prepare("SELECT phase, return_pending FROM episodes").get(),
    ).toEqual({ phase: "FINALIZED", return_pending: 1 });
    pending.close();
    const injected: string[] = [];

    await expect(
      fixture.runtime.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "next-turn"),
        inject: async (additionalContext) => {
          injected.push(additionalContext);
        },
      }),
    ).resolves.toEqual({ ok: true, status: "returned" });

    expect(injected).toEqual([
      "# Returned Collaboration Episode Outcome\n\n" +
        "Present the exact accepted result and ordered unresolved points before continuing with the Owner's newly submitted request.\n\n" +
        "Episode identity: episode-1\n\n" +
        "## Original question\n\nChoose a rollout plan.\n\n" +
        "## Accepted result\n\nUse a canary rollout.\n\n" +
        "## Ordered unresolved points\n\nNone.\n",
    ]);
    fixture.runtime.close();
  });

  it("returns only to the bound resumed Origin Session and only once", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const finalized = await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    fixture.runtime.close();
    const resumed = createColoopRuntime({
      databasePath: fixture.databasePath,
      artifactDirectory: join(fixture.directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord: new RecordingDiscordTransport(),
      now: () => new Date("2026-08-29T13:00:00.000Z"),
    });
    const injected: string[] = [];

    await expect(
      resumed.handleCodexOperation({
        hook: trustedHook(
          "replacement-origin",
          join(fixture.directory, "rollout.jsonl"),
          "get_episode",
        ),
        request: {
          operation: "get_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_NOT_FOUND" });
    await expect(
      resumed.handleCodexPromptSubmit({
        hook: trustedPromptHook("replacement-origin", "other-turn"),
        inject: async (context) => {
          injected.push(context);
        },
      }),
    ).resolves.toEqual({ ok: true, status: "nothing-pending" });
    await expect(
      resumed.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "resumed-turn"),
        inject: async (context) => {
          injected.push(context);
        },
      }),
    ).resolves.toEqual({ ok: true, status: "returned" });
    await expect(
      resumed.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "duplicate-hook-turn"),
        inject: async (context) => {
          injected.push(context);
        },
      }),
    ).resolves.toEqual({ ok: true, status: "nothing-pending" });
    expect(injected).toHaveLength(1);
    await expect(
      resumed.handleCodexOperation({
        hook: trustedHook(
          "origin-1",
          join(fixture.directory, "rollout.jsonl"),
          "get_episode",
        ),
        request: {
          operation: "get_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toEqual(finalized);
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          "SELECT phase, return_pending, returned_turn_id, outcome_result_markdown FROM episodes",
        )
        .get(),
    ).toEqual({
      phase: "FINALIZED",
      return_pending: 0,
      returned_turn_id: "resumed-turn",
      outcome_result_markdown: "Use a canary rollout.",
    });
    database.close();
    resumed.close();
  });

  it("keeps an Outcome pending when next-prompt injection fails", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );

    await expect(
      fixture.runtime.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "failed-turn"),
        inject: async () => {
          throw new Error("Codex hook output closed");
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "CODEX_INJECTION_FAILED" });
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          "SELECT phase, return_pending, return_claim_turn_id, returned_at FROM episodes",
        )
        .get(),
    ).toEqual({
      phase: "FINALIZED",
      return_pending: 1,
      return_claim_turn_id: null,
      returned_at: null,
    });
    database.close();
    await expect(
      fixture.runtime.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "retry-turn"),
        inject: async () => undefined,
      }),
    ).resolves.toEqual({ ok: true, status: "returned" });
    fixture.runtime.close();
  });

  it("lets only one overlapping next-prompt hook claim the pending Outcome", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    let releaseInjection: (() => void) | undefined;
    let markInjectionStarted: (() => void) | undefined;
    const injectionStarted = new Promise<void>((resolve) => {
      markInjectionStarted = resolve;
    });
    const injectionGate = new Promise<void>((resolve) => {
      releaseInjection = resolve;
    });
    const injected: string[] = [];

    const first = fixture.runtime.handleCodexPromptSubmit({
      hook: trustedPromptHook("origin-1", "first-turn"),
      inject: async (context) => {
        injected.push(context);
        markInjectionStarted?.();
        await injectionGate;
      },
    });
    await injectionStarted;
    await expect(
      fixture.runtime.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "overlapping-turn"),
        inject: async (context) => {
          injected.push(context);
        },
      }),
    ).resolves.toEqual({ ok: true, status: "nothing-pending" });
    releaseInjection?.();
    await expect(first).resolves.toEqual({ ok: true, status: "returned" });
    expect(injected).toHaveLength(1);
    fixture.runtime.close();
  });

  it("does not clear pending state when return acknowledgement loses its claim", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );

    await expect(
      fixture.runtime.handleCodexPromptSubmit({
        hook: trustedPromptHook("origin-1", "lost-claim-turn"),
        inject: async () => {
          const database = new DatabaseSync(fixture.databasePath);
          database.prepare("UPDATE episodes SET return_claim_turn_id = NULL").run();
          database.close();
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "RETURN_ACKNOWLEDGEMENT_FAILED",
    });
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare("SELECT phase, return_pending, returned_at FROM episodes")
        .get(),
    ).toEqual({ phase: "FINALIZED", return_pending: 1, returned_at: null });
    database.close();
    fixture.runtime.close();
  });

  it("fails closed for unsupported next-prompt identity", async () => {
    const fixture = await openProposalFixture({});
    const injected: string[] = [];

    await expect(
      fixture.runtime.handleCodexPromptSubmit({
        hook: {
          ...trustedPromptHook("origin-1", "next-turn"),
          client: { name: "codex-cli", version: "0.151.0" },
        },
        inject: async (context) => {
          injected.push(context);
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_CODEX_CLIENT" });
    expect(injected).toEqual([]);
    fixture.runtime.close();
  });

  it("fails closed without acknowledging malformed terminal data", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    fixture.runtime.close();
    const returner = createCodexPromptReturner({
      databasePath: fixture.databasePath,
    });
    const injected: string[] = [];
    const malformedValues = [
      ["original_question", ""],
      ["outcome_revision_id", ""],
      ["outcome_result_markdown", ""],
      ["finalized_at", "not-a-timestamp"],
      ["outcome_unresolved_points", '{"not":"an ordered list"}'],
    ] as const;
    for (const [column, value] of malformedValues) {
      const database = new DatabaseSync(fixture.databasePath);
      database.prepare(`UPDATE episodes SET ${column} = ?`).run(value);
      database.close();
      await expect(
        returner.handleCodexPromptSubmit({
          hook: trustedPromptHook("origin-1", `malformed-${column}`),
          inject: async (context) => {
            injected.push(context);
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "MALFORMED_EPISODE_OUTCOME",
      });
      const restore = new DatabaseSync(fixture.databasePath);
      restore
        .prepare(`UPDATE episodes SET ${column} = ?`)
        .run(
          column === "original_question"
            ? "Choose a rollout plan."
            : column === "outcome_revision_id"
              ? "proposal-revision-1"
              : column === "outcome_result_markdown"
                ? "Use a canary rollout."
                : column === "finalized_at"
                  ? "2026-08-29T12:00:00.000Z"
                  : "[]",
        );
      restore.close();
    }
    expect(injected).toEqual([]);
    const retained = new DatabaseSync(fixture.databasePath);
    expect(
      retained
        .prepare("SELECT phase, return_pending, returned_at FROM episodes")
        .get(),
    ).toEqual({ phase: "FINALIZED", return_pending: 1, returned_at: null });
    retained.close();
  });

  it("preserves unresolved-point order while filtering collaboration bookkeeping", async () => {
    const agent = new RecordingEpisodeAgent([], [
      {
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: ["Choose traffic percentage.", "Choose observation window."],
        responseId: "proposal-response-1",
      },
    ]);
    const fixture = await openProposalFixture({ agent });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleDiscordFinalization({
      ...finalizationInteraction("proposal-revision-1"),
      proposal: {
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: ["Choose traffic percentage.", "Choose observation window."],
      },
    });
    let returnedContext = "";

    await fixture.runtime.handleCodexPromptSubmit({
      hook: trustedPromptHook("origin-1", "next-turn"),
      inject: async (context) => {
        returnedContext = context;
      },
    });

    expect(returnedContext).toContain(
      "## Ordered unresolved points\n\n" +
        "1. Choose traffic percentage.\n" +
        "2. Choose observation window.\n",
    );
    expect(returnedContext).not.toContain("thread-1");
    expect(returnedContext).not.toContain("1001");
    expect(returnedContext).not.toContain("proposal-response-1");
    expect(returnedContext).not.toContain("proposal-message-1");
    expect(agent.inputs).toEqual([]);
    expect(agent.proposalInputs).toHaveLength(1);
    fixture.runtime.close();
  });

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

  it("returns one durable winner for overlapping opens from an Origin Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-concurrent-open-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    const secondToolCall = {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "tool-use-2",
        name: "mcp__coloop__open_episode",
        arguments: "{}",
      },
    };
    await writeFile(
      transcriptPath,
      `${fixtureTranscript("origin-1", [ownerMessage("Ask for input.")])}\n${JSON.stringify(secondToolCall)}`,
    );
    const discord = new RecordingDiscordTransport();
    let nextId = 1;
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      createId: () => `episode-${nextId++}`,
    });
    const request = {
      operation: "open_episode",
      arguments: { openingBrief: "# Input", originalRequest: "Ask for input." },
    };
    const secondHook = trustedHook("origin-1", transcriptPath);
    const operations = [
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath),
        approval: approveOwnerOnlyOpen("tool-use-1", "# Input", "Ask for input."),
        request,
      }),
      runtime.handleCodexOperation({
        hook: {
          ...secondHook,
          payload: { ...secondHook.payload, tool_use_id: "tool-use-2" },
        },
        approval: approveOwnerOnlyOpen("tool-use-2", "# Input", "Ask for input."),
        request,
      }),
    ];

    const results = await Promise.all(operations);
    expect(results.map((result) => result.ok && result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect([
      ["episode-1", "episode-1"],
      ["episode-2", "episode-2"],
    ]).toContainEqual(
      results.map((result) => (result.ok ? result.episode.id : undefined)),
    );
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

describe("Discord Episode Agent conversation", () => {
  it("fails closed after a Discord Gateway interruption without changing Episode Phase", async () => {
    const fixture = await openProposalFixture({});
    fixture.discord.failNextInterruption();

    await expect(
      fixture.runtime.handleConnectedPathInterruption({
        kind: "DISCORD_GATEWAY_INTERRUPTED",
      }),
    ).resolves.toEqual({ ok: true, interruptedEpisodes: 1 });
    expect(fixture.discord.interruptionEffects).toEqual([]);
    await expect(
      fixture.runtime.handleConnectedPathAvailable(),
    ).resolves.toEqual({ ok: true, presentedEpisodes: 1 });
    expect(fixture.discord.interruptionEffects).toEqual([
      {
        kind: "present_interruption",
        guildId: "2002",
        threadId: "thread-1",
        message:
          "This Collaboration Episode was interrupted and cannot continue. Cancel it from Codex, then open a new Episode from a fresh Origin Session.",
        finalizationDisabled: true,
      },
    ]);
    await expect(
      fixture.runtime.handleDiscordMessage(
        discordMessage("missed-event", "@Coloop continue after reconnect"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });

    expect(fixture.recordingAgent.inputs).toEqual([]);
    expect(fixture.discord.interruptionEffects).toHaveLength(1);
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          `SELECT episodes.phase, episodes.agent_previous_response_id,
                  episode_interruptions.error_class
           FROM episodes JOIN episode_interruptions
             ON episode_interruptions.episode_id = episodes.id`,
        )
        .get(),
    ).toEqual({
      phase: "ACTIVE",
      agent_previous_response_id: null,
      error_class: "DISCORD_GATEWAY_INTERRUPTED",
    });
    const interruptionColumns = database
      .prepare("PRAGMA table_info(episode_interruptions)")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(interruptionColumns).toEqual([
      "episode_id",
      "error_class",
      "interrupted_at",
      "presented_at",
    ]);
    database.close();

    const cancellationHook = trustedHook(
      "origin-1",
      join(fixture.directory, "rollout.jsonl"),
      "cancel_episode",
    );
    const cancellation = await fixture.runtime.handleCodexOperation({
      hook: {
        ...cancellationHook,
        payload: { ...cancellationHook.payload, tool_use_id: "cancel-tool" },
      },
      approval: createOwnerApproval({
        toolUseId: "cancel-tool",
        operation: "cancel_episode",
        episodeId: "episode-1",
      }),
      request: {
        operation: "cancel_episode",
        arguments: { episodeId: "episode-1" },
      },
    });
    expect(cancellation).toMatchObject({
      ok: true,
      episode: { phase: "CANCELLED" },
    });
    await expect(
      fixture.runtime.handleCodexOperation({
        hook: trustedHook("origin-1", join(fixture.directory, "rollout.jsonl")),
        request: {
          operation: "open_episode",
          arguments: {
            openingBrief: "# Rollout",
            originalRequest: "Choose a rollout plan.",
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      created: false,
      episode: { phase: "CANCELLED" },
    });

    const freshTranscriptPath = join(fixture.directory, "fresh-rollout.jsonl");
    await writeFile(
      freshTranscriptPath,
      fixtureTranscript("origin-2", [ownerMessage("Start fresh.")]),
    );
    await expect(
      fixture.runtime.handleCodexOperation({
        hook: trustedHook("origin-2", freshTranscriptPath),
        approval: approveOwnerOnlyOpen("tool-use-1", "# Fresh", "Start fresh."),
        request: {
          operation: "open_episode",
          arguments: { openingBrief: "# Fresh", originalRequest: "Start fresh." },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      episode: { phase: "ACTIVE" },
    });
    fixture.runtime.close();
  });

  it("does not acknowledge an Agent turn interrupted while the provider call is running", async () => {
    const agent = new DeferredAfterProposalEpisodeAgent();
    const fixture = await openProposalFixture({ agent });
    const turn = fixture.runtime.handleDiscordMessage(
      discordMessage("in-flight-event", "@Coloop answer this"),
    );
    await agent.firstTurnStarted;

    await fixture.runtime.handleConnectedPathInterruption({
      kind: "DISCORD_GATEWAY_INTERRUPTED",
    });
    agent.finishFirstTurn();

    await expect(turn).resolves.toMatchObject({
      ok: false,
      code: "EPISODE_INTERRUPTED",
    });
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          `SELECT episodes.phase, episodes.agent_previous_response_id,
                  provider_inbox.status, provider_inbox.completed_at
           FROM episodes JOIN provider_inbox
             ON provider_inbox.episode_id = episodes.id
           WHERE provider_inbox.provider_event_id = 'in-flight-event'`,
        )
        .get(),
    ).toEqual({
      phase: "ACTIVE",
      agent_previous_response_id: null,
      status: "FAILED",
      completed_at: null,
    });
    database.close();
    fixture.runtime.close();
  });

  it("streams exact-thread mentions and continues from the prior response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-agent-turn-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "coloop.sqlite");
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Review the rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const agent = new RecordingEpisodeAgent([
      { deltas: ["Start with ", "a canary."], responseId: "response-1" },
      { deltas: ["Keep the rollback gate."], responseId: "response-2" },
    ]);
    const runtime = createColoopRuntime({
      databasePath,
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent,
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
      runtime.handleDiscordMessage(
        discordMessage("discord-event-1", "@Coloop Which rollout is safer?"),
      ),
    ).resolves.toEqual({ ok: true, status: "completed" });
    await expect(
      runtime.handleDiscordMessage(
        discordMessage("discord-event-2", "@Coloop What gate should we keep?"),
      ),
    ).resolves.toEqual({ ok: true, status: "completed" });

    expect(agent.inputs).toEqual([
      {
        contextPackage:
          "# Collaboration Episode Context\n\n" +
          "## Owner\n\nReview the rollout plan.\n",
        message: "@Coloop Which rollout is safer?",
      },
      {
        contextPackage:
          "# Collaboration Episode Context\n\n" +
          "## Owner\n\nReview the rollout plan.\n",
        message: "@Coloop What gate should we keep?",
        previousResponseId: "response-1",
      },
    ]);
    expect(discord.agentResponseEffects).toEqual([
      { kind: "begin", eventId: "discord-event-1", threadId: "thread-1" },
      { kind: "delta", text: "Start with " },
      { kind: "delta", text: "a canary." },
      { kind: "complete" },
      { kind: "begin", eventId: "discord-event-2", threadId: "thread-1" },
      { kind: "delta", text: "Keep the rollback gate." },
      { kind: "complete" },
    ]);

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT provider_event_id, status FROM provider_inbox WHERE effect_kind = 'agent_turn' ORDER BY received_at",
        )
        .all(),
    ).toEqual([
      { provider_event_id: "discord-event-1", status: "COMPLETED" },
      { provider_event_id: "discord-event-2", status: "COMPLETED" },
    ]);
    expect(
      database
        .prepare("SELECT agent_previous_response_id FROM episodes")
        .get(),
    ).toEqual({ agent_previous_response_id: "response-2" });
    const localState = JSON.stringify({
      episodes: database.prepare("SELECT * FROM episodes").all(),
      inbox: database.prepare("SELECT * FROM provider_inbox").all(),
      outbox: database.prepare("SELECT * FROM recovery_outbox").all(),
      audit: database.prepare("SELECT * FROM episode_audit").all(),
    });
    expect(localState).not.toContain("@Coloop Which rollout is safer?");
    expect(localState).not.toContain("Start with a canary.");
    expect(localState).not.toContain("# Collaboration Episode Context");
    database.close();
    runtime.close();
  });

  it("serializes overlapping Agent turns onto one continuation chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-agent-queue-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Review the rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const agent = new DeferredEpisodeAgent();
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent,
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Review",
        "Review the rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review",
          originalRequest: "Review the rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    const first = runtime.handleDiscordMessage(
      discordMessage("discord-event-1", "@Coloop First question"),
    );
    await agent.firstTurnStarted;
    const second = runtime.handleDiscordMessage(
      discordMessage("discord-event-2", "@Coloop Follow-up question"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(agent.inputs).toHaveLength(1);

    agent.finishFirstTurn();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, status: "completed" },
      { ok: true, status: "completed" },
    ]);
    expect(agent.inputs.at(1)).toMatchObject({
      message: "@Coloop Follow-up question",
      previousResponseId: "response-1",
    });
    runtime.close();
  });

  it("stays quiet outside eligible exact-thread participant mentions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-agent-routing-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Review the rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const agent = new RecordingEpisodeAgent([
      { deltas: ["Bot answer"], responseId: "response-1" },
      { deltas: ["Webhook answer"], responseId: "response-2" },
    ]);
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent,
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Review",
        "Review the rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review",
          originalRequest: "Review the rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleDiscordMessage({} as DiscordMessageEvent),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_DISCORD_EVENT" });

    const ignoredEvents: DiscordMessageEvent[] = [
      {
        ...discordMessage("not-mentioned", "Ordinary participant discussion"),
        mentionsApplication: false,
      },
      { ...discordMessage("wrong-guild", "@Coloop hello"), guildId: "other" },
      { ...discordMessage("wrong-thread", "@Coloop hello"), threadId: "other" },
      {
        ...discordMessage("self-message", "@Coloop outbound"),
        authorKind: "coloop",
      },
    ];
    for (const event of ignoredEvents) {
      await expect(runtime.handleDiscordMessage(event)).resolves.toEqual({
        ok: true,
        status: "ignored",
      });
    }
    const externalBotMention = {
      ...discordMessage("external-bot", "@Coloop compare these"),
      authorKind: "external-bot" as const,
      relevantConversation: [
        { authorKind: "human" as const, content: "Option A is safer." },
        { authorKind: "webhook" as const, content: "Option B is faster." },
        {
          authorKind: "external-bot" as const,
          content: "@Coloop compare these",
        },
      ],
    };
    await expect(
      runtime.handleDiscordMessage(externalBotMention),
    ).resolves.toEqual({ ok: true, status: "completed" });
    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage("webhook", "@Coloop summarize this"),
        authorKind: "webhook",
      }),
    ).resolves.toEqual({ ok: true, status: "completed" });

    expect(agent.inputs.map((input) => input.message)).toEqual([
      "# Relevant Discord conversation\n\n" +
        "human: Option A is safer.\n\n" +
        "webhook: Option B is faster.\n\n" +
        "external-bot: @Coloop compare these",
      "@Coloop summarize this",
    ]);
    runtime.close();
  });

  it("suppresses duplicate inputs and rejects changed reuse before another Agent call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-agent-duplicate-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Review the rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const agent = new RecordingEpisodeAgent([
      { deltas: ["One answer"], responseId: "response-1" },
    ]);
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent,
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Review",
        "Review the rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review",
          originalRequest: "Review the rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);
    const event = discordMessage("discord-event-1", "@Coloop answer once");

    await expect(runtime.handleDiscordMessage(event)).resolves.toEqual({
      ok: true,
      status: "completed",
    });
    await expect(runtime.handleDiscordMessage(event)).resolves.toEqual({
      ok: true,
      status: "duplicate",
    });
    await expect(
      runtime.handleDiscordMessage({ ...event, content: "@Coloop changed input" }),
    ).resolves.toMatchObject({ ok: false, code: "DISCORD_EVENT_REUSE" });
    expect(agent.inputs).toHaveLength(1);
    runtime.close();
  });

  it("does not complete input or advance continuation after provider failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-agent-failure-"));
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
      agent: new FailingEpisodeAgent(),
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Review",
        "Review the rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Review",
          originalRequest: "Review the rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleDiscordMessage(
        discordMessage("failed-event", "@Coloop provider failure input"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "AGENT_PROVIDER_FAILED" });
    await expect(
      runtime.handleDiscordMessage(
        discordMessage("later-event", "@Coloop do not replay this"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT status, completed_at FROM provider_inbox WHERE provider_event_id = 'failed-event'",
        )
        .get(),
    ).toEqual({ status: "FAILED", completed_at: null });
    expect(
      database
        .prepare("SELECT agent_previous_response_id FROM episodes")
        .get(),
    ).toEqual({ agent_previous_response_id: null });
    expect(
      database
        .prepare(
          "SELECT state, payload FROM recovery_outbox WHERE idempotency_key = 'agent-response:failed-event'",
        )
        .get(),
    ).toEqual({ state: "ABANDONED", payload: null });
    expect(
      database
        .prepare("SELECT error_class FROM episode_interruptions")
        .get(),
    ).toEqual({ error_class: "AGENT_PROVIDER_FAILED" });
    expect(
      database
        .prepare(
          "SELECT provider_event_id FROM provider_inbox WHERE effect_kind = 'agent_turn' ORDER BY received_at",
        )
        .all(),
    ).toEqual([{ provider_event_id: "failed-event" }]);
    database.close();
    runtime.close();
  });

  it("does not acknowledge begin, append, or completion delivery failures", async () => {
    const boundaries = [
      { failure: "begin" as const, effects: [] },
      { failure: "append" as const, effects: ["begin"] },
      { failure: "complete" as const, effects: ["begin", "delta"] },
    ];
    for (const boundary of boundaries) {
      const discord = new RecordingDiscordTransport(false, false, [
        boundary.failure,
      ]);
      const fixture = await openProposalFixture({
        discord,
        agent: new RecordingEpisodeAgent([
          { deltas: ["Undeliverable response"], responseId: "response-1" },
        ]),
      });
      const eventId = `${boundary.failure}-failure`;
      await expect(
        fixture.runtime.handleDiscordMessage(
          discordMessage(eventId, `@Coloop ${eventId}`),
        ),
      ).resolves.toMatchObject({ ok: false, code: "DISCORD_DELIVERY_FAILED" });
      expect(
        discord.agentResponseEffects.map((effect) =>
          "kind" in effect ? effect.kind : undefined,
        ),
      ).toEqual(boundary.effects);
      const database = new DatabaseSync(fixture.databasePath);
      expect(
        database
          .prepare(
            `SELECT provider_inbox.status, provider_inbox.completed_at,
                    episodes.agent_previous_response_id
             FROM provider_inbox JOIN episodes
               ON episodes.id = provider_inbox.episode_id
             WHERE provider_inbox.provider_event_id = ?`,
          )
          .get(eventId),
      ).toEqual({
        status: "FAILED",
        completed_at: null,
        agent_previous_response_id: null,
      });
      database.close();
      fixture.runtime.close();
    }
  });

  it("presents selective Context Package answers and explicit missing context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-agent-context-"));
    temporaryDirectories.push(directory);
    const transcriptPath = join(directory, "rollout.jsonl");
    const originalRequest =
      "Review the rollout plan. The rollback window is ten minutes.";
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage(originalRequest)]),
    );
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath: join(directory, "coloop.sqlite"),
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent: new ContextAwareEpisodeAgent(),
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen("tool-use-1", "# Review", originalRequest),
      request: {
        operation: "open_episode",
        arguments: { openingBrief: "# Review", originalRequest },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await runtime.handleDiscordMessage(
      discordMessage("context-answer", "@Coloop What is the rollback window?"),
    );
    await runtime.handleDiscordMessage(
      discordMessage("context-gap", "@Coloop Which database version is installed?"),
    );

    expect(
      discord.agentResponseEffects.filter((effect) =>
        isTextDeltaEffect(effect),
      ),
    ).toEqual([
      { kind: "delta", text: "The approved snapshot says ten minutes." },
      {
        kind: "delta",
        text: "The approved snapshot does not include the database version.",
      },
    ]);
    runtime.close();
  });
});

describe("Outcome Proposal collaboration", () => {
  it("publishes and revises one structured proposal in its exact Episode thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-proposal-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "coloop.sqlite");
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Choose a rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const agent = new RecordingEpisodeAgent([], [
      {
        resultMarkdown: "## Recommendation\n\nUse a canary rollout.\n\n```sh\ndeploy --canary\n```",
        unresolvedPoints: ["Choose the initial traffic percentage."],
        responseId: "proposal-response-1",
      },
      {
        resultMarkdown: "## Recommendation\n\nUse a 5% canary rollout.",
        unresolvedPoints: [],
        responseId: "proposal-response-2",
      },
      {
        resultMarkdown: "## Recommendation\n\nUse a canary rollout.\n\n```sh\ndeploy --canary\n```",
        unresolvedPoints: ["Choose the initial traffic percentage."],
        responseId: "proposal-response-3",
      },
    ]);
    const ids = [
      "episode-1",
      "proposal-revision-1",
      "proposal-revision-2",
      "proposal-revision-3",
    ];
    const runtime = createColoopRuntime({
      databasePath,
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent,
      createId: () => ids.shift() ?? "unexpected-id",
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Rollout",
        "Choose a rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Rollout",
          originalRequest: "Choose a rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage(
          "unauthorized-proposal",
          "@Coloop synthesize an Outcome Proposal.",
        ),
        authorDiscordUserId: "9009",
      }),
    ).resolves.toMatchObject({ ok: false, code: "OWNER_REQUIRED" });
    expect(agent.proposalInputs).toEqual([]);

    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage(
          "proposal-event-1",
          "@Coloop turn this discussion into our recommendation.",
        ),
        authorDiscordUserId: "1001",
        relevantConversation: [
          { authorKind: "human", content: "A canary limits exposure." },
          {
            authorKind: "human",
            content: "@Coloop turn this discussion into our recommendation.",
          },
        ],
      }),
    ).resolves.toEqual({ ok: true, status: "completed" });
    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage(
          "proposal-event-2",
          "@Coloop make the rollout a 5% canary.",
        ),
        authorDiscordUserId: "9009",
      }),
    ).resolves.toEqual({ ok: true, status: "completed" });
    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage(
          "proposal-event-2",
          "@Coloop make the rollout a 5% canary.",
        ),
        authorDiscordUserId: "9009",
      }),
    ).resolves.toEqual({ ok: true, status: "duplicate" });
    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage(
          "proposal-event-2",
          "@Coloop change the Outcome Proposal to use a 10% canary.",
        ),
        authorDiscordUserId: "9009",
      }),
    ).resolves.toMatchObject({ ok: false, code: "DISCORD_EVENT_REUSE" });
    await expect(
      runtime.handleDiscordMessage(
        discordMessage(
          "proposal-event-3",
          "@Coloop restore the original Outcome Proposal content.",
        ),
      ),
    ).resolves.toEqual({ ok: true, status: "completed" });

    expect(agent.proposalInputs).toEqual([
      {
        contextPackage:
          "# Collaboration Episode Context\n\n" +
          "## Owner\n\nChoose a rollout plan.\n",
        message:
          "# Relevant Discord conversation\n\n" +
          "human: A canary limits exposure.\n\n" +
          "human: @Coloop turn this discussion into our recommendation.",
      },
      {
        contextPackage:
          "# Collaboration Episode Context\n\n" +
          "## Owner\n\nChoose a rollout plan.\n",
        message: "@Coloop make the rollout a 5% canary.",
        previousResponseId: "proposal-response-1",
      },
      {
        contextPackage:
          "# Collaboration Episode Context\n\n" +
          "## Owner\n\nChoose a rollout plan.\n",
        message: "@Coloop restore the original Outcome Proposal content.",
        previousResponseId: "proposal-response-2",
      },
    ]);
    expect(discord.proposalEffects).toEqual([
      {
        kind: "publish",
        eventId: "proposal-event-1",
        threadId: "thread-1",
        revisionId: "proposal-revision-1",
        resultMarkdown:
          "## Recommendation\n\nUse a canary rollout.\n\n```sh\ndeploy --canary\n```",
        unresolvedPoints: ["Choose the initial traffic percentage."],
        finalizationEnabled: true,
      },
      {
        kind: "revise",
        eventId: "proposal-event-2",
        guildId: "2002",
        threadId: "thread-1",
        messageId: "proposal-message-1",
        revisionId: "proposal-revision-2",
        resultMarkdown: "## Recommendation\n\nUse a 5% canary rollout.",
        unresolvedPoints: [],
        acknowledgement: "Outcome Proposal revised to proposal-revision-2.",
        finalizationEnabled: true,
      },
      {
        kind: "revise",
        eventId: "proposal-event-3",
        guildId: "2002",
        threadId: "thread-1",
        messageId: "proposal-message-1",
        revisionId: "proposal-revision-3",
        resultMarkdown:
          "## Recommendation\n\nUse a canary rollout.\n\n```sh\ndeploy --canary\n```",
        unresolvedPoints: ["Choose the initial traffic percentage."],
        acknowledgement: "Outcome Proposal revised to proposal-revision-3.",
        finalizationEnabled: true,
      },
    ]);
    await expect(
      runtime.handleCodexOperation({
        hook: trustedHook("origin-1", transcriptPath, "get_episode"),
        request: {
          operation: "get_episode",
          arguments: { episodeId: opened.episode.id },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      episode: {
        id: "episode-1",
        phase: "ACTIVE",
        outcomeProposal: {
          messageId: "proposal-message-1",
          revisionId: "proposal-revision-3",
        },
      },
    });

    const database = new DatabaseSync(databasePath);
    const localState = JSON.stringify({
      episodes: database.prepare("SELECT * FROM episodes").all(),
      inbox: database.prepare("SELECT * FROM provider_inbox").all(),
      outbox: database.prepare("SELECT * FROM recovery_outbox").all(),
    });
    expect(localState).not.toContain("Use a canary rollout");
    expect(localState).not.toContain("Choose the initial traffic percentage");
    expect(localState).not.toContain("Use a 5% canary rollout");
    database.close();
    runtime.close();
  });

  it("rejects schema-invalid Agent output without publishing or advancing state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-invalid-proposal-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "coloop.sqlite");
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Choose a rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath,
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent: new CandidateEpisodeAgent({
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: [],
        attemptedControl: "finalize",
      }),
      createId: (() => {
        const ids = ["episode-1", "proposal-revision-1"];
        return () => ids.shift() ?? "unexpected-id";
      })(),
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Rollout",
        "Choose a rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Rollout",
          originalRequest: "Choose a rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage(
          "invalid-proposal",
          "@Coloop synthesize an Outcome Proposal.",
        ),
        authorDiscordUserId: "1001",
      }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_PROPOSAL_OUTPUT" });
    expect(discord.proposalEffects).toEqual([]);

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT proposal_message_id, proposal_revision_id, proposal_digest, agent_previous_response_id FROM episodes",
        )
        .get(),
    ).toEqual({
      proposal_message_id: null,
      proposal_revision_id: null,
      proposal_digest: null,
      agent_previous_response_id: null,
    });
    database.close();
    runtime.close();
  });

  it("does not advance the current revision when its Discord edit fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coloop-proposal-delivery-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "coloop.sqlite");
    const transcriptPath = join(directory, "rollout.jsonl");
    await writeFile(
      transcriptPath,
      fixtureTranscript("origin-1", [ownerMessage("Choose a rollout plan.")]),
    );
    const discord = new RecordingDiscordTransport(false, false, [], ["revise"]);
    const agent = new RecordingEpisodeAgent([], [
      {
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: [],
        responseId: "proposal-response-1",
      },
      {
        resultMarkdown: "Use a 5% canary rollout.",
        unresolvedPoints: [],
        responseId: "proposal-response-2",
      },
    ]);
    const ids = ["episode-1", "proposal-revision-1", "proposal-revision-2"];
    const runtime = createColoopRuntime({
      databasePath,
      artifactDirectory: join(directory, "episodes"),
      ownerDiscordUserId: "1001",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent,
      createId: () => ids.shift() ?? "unexpected-id",
    });
    const opened = await runtime.handleCodexOperation({
      hook: trustedHook("origin-1", transcriptPath),
      approval: approveOwnerOnlyOpen(
        "tool-use-1",
        "# Rollout",
        "Choose a rollout plan.",
      ),
      request: {
        operation: "open_episode",
        arguments: {
          openingBrief: "# Rollout",
          originalRequest: "Choose a rollout plan.",
        },
      },
    });
    if (!opened.ok) throw new Error(opened.reason);
    await runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });

    await expect(
      runtime.handleDiscordMessage(
        discordMessage(
          "proposal-event-2",
          "@Coloop revise the Outcome Proposal to use a 5% canary.",
        ),
      ),
    ).resolves.toMatchObject({ ok: false, code: "DISCORD_DELIVERY_FAILED" });

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT proposal_message_id, proposal_revision_id, agent_previous_response_id FROM episodes",
        )
        .get(),
    ).toEqual({
      proposal_message_id: "proposal-message-1",
      proposal_revision_id: "proposal-revision-1",
      agent_previous_response_id: "proposal-response-1",
    });
    expect(
      database
        .prepare(
          "SELECT status FROM provider_inbox WHERE provider_event_id = 'proposal-event-2'",
        )
        .get(),
    ).toEqual({ status: "FAILED" });
    database.close();
    runtime.close();
  });

  it("does not advance a revision from a stale Discord acknowledgement", async () => {
    const fixture = await openProposalFixture({ staleProposalDelivery: true });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });

    await expect(
      fixture.runtime.handleDiscordMessage(
        discordMessage(
          "proposal-event-2",
          "@Coloop change the Outcome Proposal to a 5% canary.",
        ),
      ),
    ).resolves.toMatchObject({ ok: false, code: "STALE_PROPOSAL_DELIVERY" });

    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          "SELECT proposal_revision_id, agent_previous_response_id FROM episodes",
        )
        .get(),
    ).toEqual({
      proposal_revision_id: "proposal-revision-1",
      agent_previous_response_id: "proposal-response-1",
    });
    database.close();
    fixture.runtime.close();
  });

  it("does not advance proposal state after an Agent provider failure", async () => {
    const fixture = await openProposalFixture({ agent: new FailingEpisodeAgent() });

    await expect(
      fixture.runtime.handleDiscordMessage({
        ...discordMessage(
          "proposal-event-1",
          "@Coloop turn this discussion into our recommendation.",
        ),
        authorDiscordUserId: "1001",
      }),
    ).resolves.toMatchObject({ ok: false, code: "AGENT_PROVIDER_FAILED" });
    expect(proposalState(fixture.databasePath)).toEqual({
      proposal_message_id: null,
      proposal_revision_id: null,
      agent_previous_response_id: null,
    });
    await expect(
      fixture.runtime.handleDiscordMessage(
        discordMessage("later-proposal-event", "@Coloop try again"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });
    fixture.runtime.close();
  });

  it("does not advance proposal state after initial Discord publication fails", async () => {
    const fixture = await openProposalFixture({ proposalFailure: "publish" });

    await expect(
      fixture.runtime.handleDiscordMessage({
        ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
        authorDiscordUserId: "1001",
      }),
    ).resolves.toMatchObject({ ok: false, code: "DISCORD_DELIVERY_FAILED" });
    expect(proposalState(fixture.databasePath)).toEqual({
      proposal_message_id: null,
      proposal_revision_id: null,
      agent_previous_response_id: null,
    });
    await expect(
      fixture.runtime.handleDiscordMessage(
        discordMessage("later-delivery-event", "@Coloop try again"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });
    fixture.runtime.close();
  });

  it("does not create an implicit proposal during ordinary Agent conversation", async () => {
    const fixture = await openProposalFixture({
      agent: new RecordingEpisodeAgent([
        { deltas: ["A canary limits exposure."], responseId: "response-1" },
      ]),
    });

    await expect(
      fixture.runtime.handleDiscordMessage(
        discordMessage("ordinary-event", "@Coloop which rollout is safer?"),
      ),
    ).resolves.toEqual({ ok: true, status: "completed" });
    expect(fixture.discord.proposalEffects).toEqual([]);
    expect(proposalState(fixture.databasePath)).toEqual({
      proposal_message_id: null,
      proposal_revision_id: null,
      agent_previous_response_id: "response-1",
    });
    fixture.runtime.close();
  });

  it("fails closed instead of resuming an active Episode after a runtime restart", async () => {
    const fixture = await openProposalFixture({});
    fixture.runtime.close();
    const discord = new RecordingDiscordTransport();
    const runtime = createColoopRuntime({
      databasePath: fixture.databasePath,
      artifactDirectory: join(fixture.directory, "episodes"),
      ownerDiscordUserId: "9999",
      guildId: "2002",
      parentChannelId: "3003",
      discord,
      agent: new RecordingEpisodeAgent([], [
        {
          resultMarkdown: "Use a canary rollout.",
          unresolvedPoints: [],
          responseId: "proposal-response-1",
        },
      ]),
      createId: () => "proposal-revision-after-restart",
    });

    await expect(runtime.handleConnectedPathAvailable()).resolves.toEqual({
      ok: true,
      presentedEpisodes: 1,
    });
    expect(discord.interruptionEffects).toHaveLength(1);

    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage("new-owner", "@Coloop create an Outcome Proposal."),
        authorDiscordUserId: "9999",
      }),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });
    await expect(
      runtime.handleDiscordMessage({
        ...discordMessage("original-owner", "@Coloop create an Outcome Proposal."),
        authorDiscordUserId: "1001",
      }),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });
    expect(discord.proposalEffects).toEqual([]);
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          `SELECT episodes.phase, episode_interruptions.error_class
           FROM episodes JOIN episode_interruptions
             ON episode_interruptions.episode_id = episodes.id`,
        )
        .get(),
    ).toEqual({ phase: "ACTIVE", error_class: "RUNTIME_INTERRUPTED" });
    database.close();
    runtime.close();
  });
});

describe("Episode Outcome finalization", () => {
  it("refuses finalization after the connected path is interrupted", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleConnectedPathInterruption({
      kind: "DISCORD_GATEWAY_INTERRUPTED",
    });

    await expect(
      fixture.runtime.handleDiscordFinalization(
        finalizationInteraction("proposal-revision-1"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_INTERRUPTED" });
    await expect(
      fixture.runtime.handleCodexOperation({
        hook: trustedHook(
          "origin-1",
          join(fixture.directory, "rollout.jsonl"),
          "get_episode",
        ),
        request: {
          operation: "get_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      episode: {
        phase: "ACTIVE",
        interruption: {
          kind: "DISCORD_GATEWAY_INTERRUPTED",
          interruptedAt: "2026-08-29T12:00:00.000Z",
          requiresCancellation: true,
        },
      },
    });
    fixture.runtime.close();
  });

  it("atomically finalizes the exact visible proposal before Discord acknowledgement", async () => {
    const resultMarkdown =
      "## Recommendation\n\nUse a canary rollout.\n\n```sh\ndeploy --canary\n```";
    const unresolvedPoints = [
      "Choose the initial traffic percentage.",
      "Confirm the rollback owner.",
    ];
    const fixture = await openProposalFixture({
      agent: new RecordingEpisodeAgent([], [
        {
          resultMarkdown,
          unresolvedPoints,
          responseId: "proposal-response-1",
        },
      ]),
    });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });

    await expect(
      fixture.runtime.handleDiscordFinalization({
        interactionId: "finalize-interaction-1",
        guildId: "2002",
        threadId: "thread-1",
        actorKind: "human",
        actorDiscordUserId: "1001",
        revisionId: "proposal-revision-1",
        proposal: {
          resultMarkdown,
          unresolvedPoints,
        },
      }),
    ).resolves.toEqual({
      ok: true,
      episode: {
        id: "episode-1",
        phase: "FINALIZED",
        outcome: {
          episodeId: "episode-1",
          acceptedProposalRevisionId: "proposal-revision-1",
          resultMarkdown,
          unresolvedPoints,
          finalizedAt: "2026-08-29T12:00:00.000Z",
        },
      },
    });
    expect(fixture.discord.finalizationEffects).toEqual([
      {
        kind: "present_finalization",
        idempotencyKey: "episode-finalized:episode-1",
        guildId: "2002",
        threadId: "thread-1",
        episodeId: "episode-1",
        status: "FINALIZED",
        controlsDisabled: true,
        threadArchived: false,
        threadLocked: false,
        threadWritable: true,
      },
    ]);

    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          `SELECT phase, phase_version, outcome_revision_id, outcome_result_markdown,
           outcome_unresolved_points, finalized_at, return_pending,
           context_retention_deadline FROM episodes`,
        )
        .get(),
    ).toMatchObject({
      phase: "FINALIZED",
      phase_version: 3,
      outcome_revision_id: "proposal-revision-1",
      outcome_result_markdown: resultMarkdown,
      outcome_unresolved_points: JSON.stringify(unresolvedPoints),
      finalized_at: "2026-08-29T12:00:00.000Z",
      return_pending: 1,
      context_retention_deadline: "2026-09-01T12:00:00.000Z",
    });
    database.close();
    fixture.runtime.close();
  });

  it("returns one terminal effect for duplicate input and rejects changed reuse", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const interaction = {
      interactionId: "finalize-interaction-1",
      guildId: "2002",
      threadId: "thread-1",
      actorKind: "human",
      actorDiscordUserId: "1001",
      revisionId: "proposal-revision-1",
      proposal: {
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: [] as string[],
      },
    } as const;

    const first = await fixture.runtime.handleDiscordFinalization(interaction);
    await expect(
      fixture.runtime.handleDiscordFinalization(interaction),
    ).resolves.toEqual(first);
    expect(fixture.discord.finalizationEffects).toHaveLength(1);
    await expect(
      fixture.runtime.handleDiscordFinalization({
        ...interaction,
        proposal: {
          resultMarkdown: "Changed after acceptance.",
          unresolvedPoints: [],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "DISCORD_FINALIZATION_REUSE",
    });
    fixture.runtime.close();
  });

  it("rejects malformed finalization interaction data", async () => {
    const fixture = await openProposalFixture({});

    await expect(
      fixture.runtime.handleDiscordFinalization({
        interactionId: "finalize-malformed",
        guildId: "2002",
        threadId: "thread-1",
        actorKind: "human",
        actorDiscordUserId: "1001",
        revisionId: "proposal-revision-1",
        proposal: { resultMarkdown: "", unresolvedPoints: [42] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "INVALID_DISCORD_FINALIZATION",
    });
    expect(fixture.discord.finalizationEffects).toEqual([]);
    fixture.runtime.close();
  });

  it("requires a delivered current proposal from the snapshotted Owner and exact thread", async () => {
    const noProposal = await openProposalFixture({});
    await expect(
      noProposal.runtime.handleDiscordFinalization(
        finalizationInteraction("proposal-revision-1"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "OUTCOME_PROPOSAL_REQUIRED" });
    noProposal.runtime.close();

    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await expect(
      fixture.runtime.handleDiscordFinalization({
        ...finalizationInteraction("proposal-revision-1"),
        actorDiscordUserId: "9009",
      }),
    ).resolves.toMatchObject({ ok: false, code: "OWNER_REQUIRED" });
    await expect(
      fixture.runtime.handleDiscordFinalization({
        ...finalizationInteraction("proposal-revision-1"),
        actorKind: "bot",
        actorDiscordUserId: "1001",
      }),
    ).resolves.toMatchObject({ ok: false, code: "OWNER_REQUIRED" });
    await expect(
      fixture.runtime.handleDiscordFinalization({
        ...finalizationInteraction("proposal-revision-1"),
        guildId: "wrong-guild",
      }),
    ).resolves.toMatchObject({ ok: false, code: "FINALIZATION_SCOPE_INVALID" });
    await expect(
      fixture.runtime.handleDiscordFinalization({
        ...finalizationInteraction("proposal-revision-1"),
        threadId: "wrong-thread",
      }),
    ).resolves.toMatchObject({ ok: false, code: "FINALIZATION_SCOPE_INVALID" });
    expect(fixture.discord.finalizationEffects).toEqual([]);
    fixture.runtime.close();
  });

  it("rejects stale revision identity or changed visible content", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });

    await expect(
      fixture.runtime.handleDiscordFinalization(
        finalizationInteraction("stale-revision"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "STALE_OUTCOME_PROPOSAL" });
    await expect(
      fixture.runtime.handleDiscordFinalization({
        ...finalizationInteraction("proposal-revision-1"),
        proposal: {
          resultMarkdown: "Changed without a delivered revision.",
          unresolvedPoints: [],
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "STALE_OUTCOME_PROPOSAL" });
    expect(fixture.discord.finalizationEffects).toEqual([]);
    fixture.runtime.close();
  });

  it("disables finalization while an Episode Agent turn is running", async () => {
    const agent = new DeferredAfterProposalEpisodeAgent();
    const fixture = await openProposalFixture({ agent });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const turn = fixture.runtime.handleDiscordMessage(
      discordMessage("agent-event", "@Coloop check the rollout risk."),
    );
    await agent.firstTurnStarted;
    expect(fixture.discord.finalizationControlEffects).toEqual([
      {
        enabled: false,
        guildId: "2002",
        threadId: "thread-1",
        revisionId: "proposal-revision-1",
      },
    ]);
    await expect(
      fixture.runtime.handleDiscordFinalization(
        finalizationInteraction("proposal-revision-1"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_AGENT_BUSY" });
    agent.finishFirstTurn();
    await turn;
    expect(fixture.discord.finalizationControlEffects.at(-1)).toEqual({
      enabled: true,
      guildId: "2002",
      threadId: "thread-1",
      revisionId: "proposal-revision-1",
    });
    fixture.runtime.close();
  });

  it("disables the current control throughout an Outcome Proposal revision run", async () => {
    const agent = new DeferredSecondProposalEpisodeAgent();
    const fixture = await openProposalFixture({ agent });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const revision = fixture.runtime.handleDiscordMessage(
      discordMessage(
        "proposal-event-2",
        "@Coloop revise the Outcome Proposal to use a 5% canary.",
      ),
    );
    await agent.proposalStarted;
    expect(fixture.discord.finalizationControlEffects).toEqual([
      {
        enabled: false,
        guildId: "2002",
        threadId: "thread-1",
        revisionId: "proposal-revision-1",
      },
    ]);
    await expect(
      fixture.runtime.handleDiscordFinalization(
        finalizationInteraction("proposal-revision-1"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "EPISODE_AGENT_BUSY" });
    agent.finishProposal();
    await expect(revision).resolves.toEqual({ ok: true, status: "completed" });
    expect(fixture.discord.proposalEffects.at(-1)).toMatchObject({
      kind: "revise",
      revisionId: "proposal-revision-2",
      finalizationEnabled: true,
    });
    fixture.runtime.close();
  });

  it("keeps the first terminal result immutable without another model effect", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const finalized = await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    if (!finalized.ok) throw new Error(finalized.reason);

    await expect(
      fixture.runtime.handleDiscordMessage(
        discordMessage("late-message", "@Coloop revise the Outcome Proposal."),
      ),
    ).resolves.toEqual({ ok: true, status: "ignored" });
    await expect(
      fixture.runtime.handleCodexOperation({
        hook: trustedHook("origin-1", join(fixture.directory, "rollout.jsonl"), "cancel_episode"),
        approval: createOwnerApproval({
          toolUseId: "tool-use-1",
          operation: "cancel_episode",
          episodeId: "episode-1",
        }),
        request: {
          operation: "cancel_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toEqual(finalized);
    await expect(
      fixture.runtime.handleCodexOperation({
        hook: trustedHook("origin-1", join(fixture.directory, "rollout.jsonl"), "get_episode"),
        request: {
          operation: "get_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toEqual(finalized);
    expect(fixture.recordingAgent.proposalInputs).toHaveLength(1);
    expect(fixture.recordingAgent.inputs).toEqual([]);
    expect(fixture.discord.finalizationEffects).toHaveLength(1);
    expect(fixture.discord.effects).not.toContainEqual(
      expect.objectContaining({ kind: "present_cancellation" }),
    );
    fixture.runtime.close();
  });

  it("commits finalization before acknowledgement so it wins a terminal race", async () => {
    const discord = new DeferredFinalizationDiscordTransport();
    const fixture = await openProposalFixture({ discord });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const finalization = fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    await discord.presentationStarted;
    const database = new DatabaseSync(fixture.databasePath);
    expect(database.prepare("SELECT phase FROM episodes").get()).toEqual({
      phase: "FINALIZED",
    });
    database.close();
    await expect(
      fixture.runtime.handleCodexOperation({
        hook: trustedHook("origin-1", join(fixture.directory, "rollout.jsonl"), "cancel_episode"),
        approval: createOwnerApproval({
          toolUseId: "tool-use-1",
          operation: "cancel_episode",
          episodeId: "episode-1",
        }),
        request: {
          operation: "cancel_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      episode: { phase: "FINALIZED" },
    });
    discord.finishPresentation();
    await expect(finalization).resolves.toMatchObject({
      ok: true,
      episode: { phase: "FINALIZED" },
    });
    expect(discord.effects).not.toContainEqual(
      expect.objectContaining({ kind: "present_cancellation" }),
    );
    fixture.runtime.close();
  });

  it("cannot finalize after cancellation wins the terminal race", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    await fixture.runtime.handleCodexOperation({
      hook: trustedHook("origin-1", join(fixture.directory, "rollout.jsonl"), "cancel_episode"),
      approval: createOwnerApproval({
        toolUseId: "tool-use-1",
        operation: "cancel_episode",
        episodeId: "episode-1",
      }),
      request: {
        operation: "cancel_episode",
        arguments: { episodeId: "episode-1" },
      },
    });

    await expect(
      fixture.runtime.handleDiscordFinalization(
        finalizationInteraction("proposal-revision-1"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "FINALIZATION_UNAVAILABLE" });
    expect(fixture.discord.finalizationEffects).toEqual([]);
    fixture.runtime.close();
  });

  it("retries an unacknowledged terminal presentation without another transition", async () => {
    const fixture = await openProposalFixture({ finalizationFailure: true });
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const interaction = finalizationInteraction("proposal-revision-1");

    await expect(
      fixture.runtime.handleDiscordFinalization(interaction),
    ).resolves.toMatchObject({ ok: false, code: "DISCORD_PRESENTATION_FAILED" });
    await expect(
      fixture.runtime.handleDiscordFinalization(interaction),
    ).resolves.toMatchObject({
      ok: true,
      episode: { phase: "FINALIZED" },
    });
    expect(fixture.discord.finalizationEffects).toHaveLength(1);
    const database = new DatabaseSync(fixture.databasePath);
    expect(
      database
        .prepare(
          "SELECT phase, phase_version FROM episodes",
        )
        .get(),
    ).toEqual({ phase: "FINALIZED", phase_version: 3 });
    expect(
      database
        .prepare(
          `SELECT state FROM recovery_outbox
           WHERE action_kind = 'DISCORD_EPISODE_FINALIZED'`,
        )
        .get(),
    ).toEqual({ state: "ACKNOWLEDGED" });
    database.close();
    fixture.runtime.close();
  });

  it("retains the exact Episode Outcome after reopening local state", async () => {
    const fixture = await openProposalFixture({});
    await fixture.runtime.handleDiscordMessage({
      ...discordMessage("proposal-event-1", "@Coloop create an Outcome Proposal."),
      authorDiscordUserId: "1001",
    });
    const finalized = await fixture.runtime.handleDiscordFinalization(
      finalizationInteraction("proposal-revision-1"),
    );
    fixture.runtime.close();
    const reopened = createColoopRuntime({
      databasePath: fixture.databasePath,
      artifactDirectory: join(fixture.directory, "episodes"),
      ownerDiscordUserId: "9999",
      guildId: "2002",
      parentChannelId: "3003",
      discord: new RecordingDiscordTransport(),
    });

    await expect(
      reopened.handleCodexOperation({
        hook: trustedHook("origin-1", join(fixture.directory, "rollout.jsonl"), "get_episode"),
        request: {
          operation: "get_episode",
          arguments: { episodeId: "episode-1" },
        },
      }),
    ).resolves.toEqual(finalized);
    reopened.close();
  });
});

async function openProposalFixture(options: {
  readonly agent?: EpisodeAgentTransport;
  readonly discord?: RecordingDiscordTransport;
  readonly finalizationFailure?: boolean;
  readonly proposalFailure?: "publish" | "revise";
  readonly staleProposalDelivery?: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), "coloop-proposal-fixture-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "coloop.sqlite");
  const transcriptPath = join(directory, "rollout.jsonl");
  await writeFile(
    transcriptPath,
    fixtureTranscript("origin-1", [ownerMessage("Choose a rollout plan.")]),
  );
  const discord =
    options.discord ??
    new RecordingDiscordTransport(
      false,
      false,
      [],
      options.proposalFailure === undefined ? [] : [options.proposalFailure],
      options.staleProposalDelivery ?? false,
      options.finalizationFailure ?? false,
    );
  const defaultAgent = new RecordingEpisodeAgent([], [
    {
      resultMarkdown: "Use a canary rollout.",
      unresolvedPoints: [],
      responseId: "proposal-response-1",
    },
    {
      resultMarkdown: "Use a 5% canary rollout.",
      unresolvedPoints: [],
      responseId: "proposal-response-2",
    },
  ]);
  const ids = ["episode-1", "proposal-revision-1", "proposal-revision-2"];
  const agent = options.agent ?? defaultAgent;
  const runtime = createColoopRuntime({
    databasePath,
    artifactDirectory: join(directory, "episodes"),
    ownerDiscordUserId: "1001",
    guildId: "2002",
    parentChannelId: "3003",
    discord,
    agent,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    createId: () => ids.shift() ?? "unexpected-id",
  });
  const opened = await runtime.handleCodexOperation({
    hook: trustedHook("origin-1", transcriptPath),
    approval: approveOwnerOnlyOpen(
      "tool-use-1",
      "# Rollout",
      "Choose a rollout plan.",
    ),
    request: {
      operation: "open_episode",
      arguments: {
        openingBrief: "# Rollout",
        originalRequest: "Choose a rollout plan.",
      },
    },
  });
  if (!opened.ok) throw new Error(opened.reason);
  return {
    agent,
    databasePath,
    directory,
    discord,
    recordingAgent: defaultAgent,
    runtime,
  };
}

function proposalState(databasePath: string): unknown {
  const database = new DatabaseSync(databasePath);
  const state = database
    .prepare(
      "SELECT proposal_message_id, proposal_revision_id, agent_previous_response_id FROM episodes",
    )
    .get();
  database.close();
  return state;
}

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

function trustedPromptHook(sessionId: string, turnId: string) {
  return {
    client: { name: "codex-cli" as const, version: "0.150.1" as const },
    payload: {
      hook_event_name: "UserPromptSubmit" as const,
      session_id: sessionId,
      turn_id: turnId,
      prompt: "Continue with the rollout work.",
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

function discordMessage(eventId: string, content: string): DiscordMessageEvent {
  return {
    eventId,
    guildId: "2002",
    threadId: "thread-1",
    authorKind: "human",
    content,
    mentionsApplication: true,
  };
}

function finalizationInteraction(revisionId: string) {
  return {
    interactionId: `finalize-${revisionId}`,
    guildId: "2002",
    threadId: "thread-1",
    actorKind: "human" as const,
    actorDiscordUserId: "1001",
    revisionId,
    proposal: {
      resultMarkdown: "Use a canary rollout.",
      unresolvedPoints: [] as string[],
    },
  };
}

function isTextDeltaEffect(
  value: object,
): value is { readonly kind: "delta"; readonly text: string } {
  return "kind" in value && value.kind === "delta";
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
  readonly agentResponseEffects: object[] = [];
  readonly proposalEffects: object[] = [];
  readonly finalizationEffects: object[] = [];
  readonly finalizationControlEffects: object[] = [];
  readonly interruptionEffects: object[] = [];
  private failInterruptionOnce = false;

  constructor(
    private readonly failProvisioning = false,
    private failCancellationOnce = false,
    private readonly agentDeliveryFailures: Array<
      "begin" | "append" | "complete"
    > = [],
    private readonly proposalDeliveryFailures: Array<"publish" | "revise"> = [],
    private staleProposalDelivery = false,
    private failFinalizationOnce = false,
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

  async presentInterruption(
    input: Parameters<DiscordEpisodeTransport["presentInterruption"]>[0],
  ): Promise<void> {
    if (this.failInterruptionOnce) {
      this.failInterruptionOnce = false;
      throw new Error("Discord unavailable");
    }
    this.interruptionEffects.push({ kind: "present_interruption", ...input });
  }

  failNextInterruption(): void {
    this.failInterruptionOnce = true;
  }

  async beginAgentResponse(input: {
    readonly eventId: string;
    readonly guildId: string;
    readonly threadId: string;
  }) {
    const failure = this.agentDeliveryFailures.shift();
    if (failure === "begin") throw new Error("Discord unavailable");
    this.agentResponseEffects.push({
      kind: "begin",
      eventId: input.eventId,
      threadId: input.threadId,
    });
    return {
      appendText: async (text: string) => {
        if (failure === "append") throw new Error("Discord unavailable");
        this.agentResponseEffects.push({ kind: "delta", text });
      },
      complete: async () => {
        if (failure === "complete") throw new Error("Discord unavailable");
        this.agentResponseEffects.push({ kind: "complete" });
      },
    };
  }

  async publishOutcomeProposal(
    input: Parameters<DiscordEpisodeTransport["publishOutcomeProposal"]>[0],
  ): ReturnType<DiscordEpisodeTransport["publishOutcomeProposal"]> {
    if (this.proposalDeliveryFailures[0] === "publish") {
      this.proposalDeliveryFailures.shift();
      throw new Error("Discord unavailable");
    }
    this.proposalEffects.push({
      kind: "publish",
      eventId: input.eventId,
      threadId: input.threadId,
      revisionId: input.revisionId,
      resultMarkdown: input.resultMarkdown,
      unresolvedPoints: input.unresolvedPoints,
      finalizationEnabled: input.finalizationEnabled,
    });
    return {
      messageId: "proposal-message-1",
      revisionId: input.revisionId,
      contentSha256: input.contentSha256,
    };
  }

  async reviseOutcomeProposal(
    input: Parameters<DiscordEpisodeTransport["reviseOutcomeProposal"]>[0],
  ): ReturnType<DiscordEpisodeTransport["reviseOutcomeProposal"]> {
    if (this.proposalDeliveryFailures[0] === "revise") {
      this.proposalDeliveryFailures.shift();
      throw new Error("Discord unavailable");
    }
    this.proposalEffects.push({
      kind: "revise",
      eventId: input.eventId,
      guildId: input.guildId,
      threadId: input.threadId,
      messageId: input.messageId,
      revisionId: input.revisionId,
      resultMarkdown: input.resultMarkdown,
      unresolvedPoints: input.unresolvedPoints,
      acknowledgement: input.acknowledgement,
      finalizationEnabled: input.finalizationEnabled,
    });
    const revisionId = this.staleProposalDelivery
      ? "stale-revision"
      : input.revisionId;
    this.staleProposalDelivery = false;
    return {
      messageId: input.messageId,
      revisionId,
      contentSha256: input.contentSha256,
    };
  }

  async presentFinalization(
    input: Parameters<DiscordEpisodeTransport["presentFinalization"]>[0],
  ): Promise<void> {
    if (this.failFinalizationOnce) {
      this.failFinalizationOnce = false;
      throw new Error("Discord unavailable");
    }
    this.finalizationEffects.push({
      kind: "present_finalization",
      ...input,
    });
  }

  async setFinalizationEnabled(
    input: Parameters<DiscordEpisodeTransport["setFinalizationEnabled"]>[0],
  ): Promise<void> {
    this.finalizationControlEffects.push(input);
  }
}

class DeferredFinalizationDiscordTransport extends RecordingDiscordTransport {
  readonly presentationStarted: Promise<void>;
  private resolvePresentationStarted!: () => void;
  private readonly presentationFinished: Promise<void>;
  private resolvePresentationFinished!: () => void;

  constructor() {
    super();
    this.presentationStarted = new Promise((resolve) => {
      this.resolvePresentationStarted = resolve;
    });
    this.presentationFinished = new Promise((resolve) => {
      this.resolvePresentationFinished = resolve;
    });
  }

  override async presentFinalization(
    input: Parameters<DiscordEpisodeTransport["presentFinalization"]>[0],
  ): Promise<void> {
    this.resolvePresentationStarted();
    await this.presentationFinished;
    await super.presentFinalization(input);
  }

  finishPresentation(): void {
    this.resolvePresentationFinished();
  }
}

class RecordingEpisodeAgent implements EpisodeAgentTransport {
  readonly inputs: Array<{
    readonly contextPackage: string;
    readonly message: string;
    readonly previousResponseId?: string;
  }> = [];
  readonly proposalInputs: Array<{
    readonly contextPackage: string;
    readonly message: string;
    readonly previousResponseId?: string;
  }> = [];

  constructor(
    private readonly responses: Array<{
      readonly deltas: readonly string[];
      readonly responseId: string;
    }>,
    private readonly proposals: Array<{
      readonly resultMarkdown: string;
      readonly unresolvedPoints: readonly string[];
      readonly responseId: string;
    }> = [],
  ) {}

  async streamResponse(
    input: Parameters<EpisodeAgentTransport["streamResponse"]>[0],
  ): ReturnType<EpisodeAgentTransport["streamResponse"]> {
    this.inputs.push({
      contextPackage: input.contextPackage,
      message: input.message,
      ...(input.previousResponseId === undefined
        ? {}
        : { previousResponseId: input.previousResponseId }),
    });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No Agent response configured.");
    for (const delta of response.deltas) {
      const delivery = await input.onTextDelta(delta);
      if (!delivery.ok) return delivery;
    }
    return { ok: true, responseId: response.responseId };
  }

  async synthesizeOutcomeProposal(
    input: Parameters<EpisodeAgentTransport["synthesizeOutcomeProposal"]>[0],
  ): ReturnType<EpisodeAgentTransport["synthesizeOutcomeProposal"]> {
    this.proposalInputs.push(input);
    const proposal = this.proposals.shift();
    if (proposal === undefined) throw new Error("No proposal configured.");
    return {
      ok: true,
      responseId: proposal.responseId,
      candidate: {
        resultMarkdown: proposal.resultMarkdown,
        unresolvedPoints: proposal.unresolvedPoints,
      },
    };
  }
}

class DeferredEpisodeAgent implements EpisodeAgentTransport {
  readonly inputs: Array<{
    readonly message: string;
    readonly previousResponseId?: string;
  }> = [];
  readonly firstTurnStarted: Promise<void>;
  private resolveFirstTurnStarted!: () => void;
  private readonly firstTurnFinished: Promise<void>;
  private resolveFirstTurnFinished!: () => void;

  constructor() {
    this.firstTurnStarted = new Promise((resolve) => {
      this.resolveFirstTurnStarted = resolve;
    });
    this.firstTurnFinished = new Promise((resolve) => {
      this.resolveFirstTurnFinished = resolve;
    });
  }

  async streamResponse(
    input: Parameters<EpisodeAgentTransport["streamResponse"]>[0],
  ): ReturnType<EpisodeAgentTransport["streamResponse"]> {
    const turn = this.inputs.length + 1;
    this.inputs.push({
      message: input.message,
      ...(input.previousResponseId === undefined
        ? {}
        : { previousResponseId: input.previousResponseId }),
    });
    if (turn === 1) {
      this.resolveFirstTurnStarted();
      await this.firstTurnFinished;
    }
    const delivery = await input.onTextDelta(`Answer ${turn}`);
    if (!delivery.ok) return delivery;
    return { ok: true, responseId: `response-${turn}` };
  }

  finishFirstTurn(): void {
    this.resolveFirstTurnFinished();
  }

  async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    return { ok: false, reason: "provider-failed" };
  }
}

class DeferredAfterProposalEpisodeAgent extends DeferredEpisodeAgent {
  override async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    return {
      ok: true,
      responseId: "proposal-response-1",
      candidate: {
        resultMarkdown: "Use a canary rollout.",
        unresolvedPoints: [],
      },
    };
  }
}

class DeferredProposalEpisodeAgent implements EpisodeAgentTransport {
  readonly proposalStarted: Promise<void>;
  private resolveProposalStarted!: () => void;
  private readonly proposalFinished: Promise<void>;
  private resolveProposalFinished!: () => void;

  constructor() {
    this.proposalStarted = new Promise((resolve) => {
      this.resolveProposalStarted = resolve;
    });
    this.proposalFinished = new Promise((resolve) => {
      this.resolveProposalFinished = resolve;
    });
  }

  async streamResponse(): ReturnType<EpisodeAgentTransport["streamResponse"]> {
    return { ok: false, reason: "provider-failed" };
  }

  async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    this.resolveProposalStarted();
    await this.proposalFinished;
    return {
      ok: true,
      responseId: "proposal-response-2",
      candidate: {
        resultMarkdown: "Use a 5% canary rollout.",
        unresolvedPoints: [],
      },
    };
  }

  finishProposal(): void {
    this.resolveProposalFinished();
  }
}

class DeferredSecondProposalEpisodeAgent extends DeferredProposalEpisodeAgent {
  private proposalCount = 0;

  override async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    this.proposalCount += 1;
    if (this.proposalCount === 1) {
      return {
        ok: true,
        responseId: "proposal-response-1",
        candidate: {
          resultMarkdown: "Use a canary rollout.",
          unresolvedPoints: [],
        },
      };
    }
    return await super.synthesizeOutcomeProposal();
  }
}

class FailingEpisodeAgent implements EpisodeAgentTransport {
  async streamResponse(): ReturnType<EpisodeAgentTransport["streamResponse"]> {
    return { ok: false, reason: "provider-failed" };
  }

  async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    return { ok: false, reason: "provider-failed" };
  }
}

class CandidateEpisodeAgent implements EpisodeAgentTransport {
  constructor(private readonly candidate: unknown) {}

  async streamResponse(): ReturnType<EpisodeAgentTransport["streamResponse"]> {
    return { ok: false, reason: "provider-failed" };
  }

  async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    return { ok: true, responseId: "response-1", candidate: this.candidate };
  }
}

class ContextAwareEpisodeAgent implements EpisodeAgentTransport {
  private turn = 0;

  async streamResponse(
    input: Parameters<EpisodeAgentTransport["streamResponse"]>[0],
  ): ReturnType<EpisodeAgentTransport["streamResponse"]> {
    this.turn += 1;
    const text = input.message.includes("rollback")
      ? input.contextPackage.includes("rollback window is ten minutes")
        ? "The approved snapshot says ten minutes."
        : "The approved snapshot does not include the rollback window."
      : "The approved snapshot does not include the database version.";
    const delivery = await input.onTextDelta(text);
    return delivery.ok
      ? { ok: true, responseId: `response-${this.turn}` }
      : delivery;
  }

  async synthesizeOutcomeProposal(): ReturnType<
    EpisodeAgentTransport["synthesizeOutcomeProposal"]
  > {
    return { ok: false, reason: "provider-failed" };
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
  ): ReturnType<DiscordEpisodeTransport["provisionEpisode"]> {
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

  async presentInterruption(): Promise<void> {
    throw new Error("Interruption presentation is not used by this fixture.");
  }

  async beginAgentResponse(): ReturnType<
    DiscordEpisodeTransport["beginAgentResponse"]
  > {
    throw new Error("Agent responses are not used by this fixture.");
  }

  async publishOutcomeProposal(): ReturnType<
    DiscordEpisodeTransport["publishOutcomeProposal"]
  > {
    throw new Error("Outcome Proposals are not used by this fixture.");
  }

  async reviseOutcomeProposal(): ReturnType<
    DiscordEpisodeTransport["reviseOutcomeProposal"]
  > {
    throw new Error("Outcome Proposals are not used by this fixture.");
  }

  async presentFinalization(): Promise<void> {
    throw new Error("Finalization is not used by this fixture.");
  }

  async setFinalizationEnabled(): Promise<void> {
    throw new Error("Finalization controls are not used by this fixture.");
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
