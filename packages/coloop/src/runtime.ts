import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EpisodeAgent } from "@coloop/core";
import type {
  CodexRequest,
  EpisodeToolArguments,
} from "./codex-episode-contract";

// PRD #41 fixes terminal Context Package retention at 72 hours; changing this
// alters the Owner-approved disclosure lifecycle.
const contextPackageRetentionMs = 72 * 60 * 60 * 1_000;

export type EpisodePhase = "OPENING" | "ACTIVE" | "FINALIZED" | "CANCELLED";

export interface OutcomeProposalContent {
  readonly resultMarkdown: string;
  readonly unresolvedPoints: readonly string[];
}

interface ProposalDeliveryReceipt {
  readonly messageId: string;
  readonly revisionId: string;
  readonly contentSha256: string;
}

export interface DiscordEpisodeTransport {
  provisionEpisode(input: {
    readonly idempotencyKey: string;
    readonly guildId: string;
    readonly parentChannelId: string;
    readonly ownerDiscordUserId: string;
    readonly episodeId: string;
    readonly openingBrief: string;
  }): Promise<{ readonly threadId: string; readonly threadUrl: string }>;
  presentCancellation(input: {
    readonly idempotencyKey: string;
    readonly guildId: string;
    readonly threadId: string;
    readonly episodeId: string;
    readonly reason?: string;
  }): Promise<void>;
  beginAgentResponse(input: {
    readonly eventId: string;
    readonly guildId: string;
    readonly threadId: string;
  }): Promise<{
    appendText(delta: string): Promise<void>;
    complete(): Promise<void>;
  }>;
  publishOutcomeProposal(input: OutcomeProposalContent & {
    readonly eventId: string;
    readonly guildId: string;
    readonly threadId: string;
    readonly revisionId: string;
    readonly contentSha256: string;
    readonly finalizationEnabled: true;
  }): Promise<ProposalDeliveryReceipt>;
  reviseOutcomeProposal(input: OutcomeProposalContent & {
    readonly eventId: string;
    readonly guildId: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly revisionId: string;
    readonly contentSha256: string;
    readonly acknowledgement: string;
  }): Promise<ProposalDeliveryReceipt>;
}

export type EpisodeAgentTransport = EpisodeAgent;

export interface DiscordMessageEvent {
  readonly eventId: string;
  readonly guildId: string;
  readonly threadId: string;
  readonly authorKind: "human" | "external-bot" | "webhook" | "coloop";
  readonly authorDiscordUserId?: string;
  readonly content: string;
  readonly mentionsApplication: boolean;
  readonly relevantConversation?: readonly DiscordConversationMessage[];
}

export interface DiscordConversationMessage {
  readonly authorKind: "human" | "external-bot" | "webhook";
  readonly content: string;
}

export type DiscordMessageResult =
  | { readonly ok: true; readonly status: "completed" | "duplicate" | "ignored" }
  | { readonly ok: false; readonly reason: string; readonly code: string };

export type EpisodeView =
  | {
      readonly id: string;
      readonly originSessionId: string;
      readonly phase: "OPENING" | "ACTIVE";
      readonly collaborationUrl?: string;
      readonly contextPackage: {
        readonly reference: string;
        readonly sha256: string;
      };
      readonly outcomeProposal?: {
        readonly messageId: string;
        readonly revisionId: string;
        readonly sha256: string;
      };
    }
  | {
      readonly id: string;
      readonly phase: "CANCELLED";
      readonly cancellation: {
        readonly cancelledAt: string;
        readonly reason?: string;
      };
    }
  | { readonly id: string; readonly phase: "FINALIZED" };

interface RuntimeConfiguration {
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly ownerDiscordUserId: string;
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly discord: DiscordEpisodeTransport;
  readonly agent?: EpisodeAgentTransport;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

interface TrustedHook {
  readonly event: "PreToolUse";
  readonly client: "codex-cli";
  readonly clientVersion: "0.150.1";
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly transcriptPath: string;
}

export type EpisodeOperationResult =
  | { readonly ok: true; readonly episode: EpisodeView; readonly created?: boolean }
  | { readonly ok: false; readonly reason: string; readonly code: string };

export interface EpisodeModule {
  openEpisode(input: {
    readonly originSessionId: string;
    readonly originTurnId: string;
    readonly originalQuestion: string;
    readonly openingBrief: string;
    readonly contextMarkdown: string;
  }): Promise<EpisodeOperationResult>;
  getEpisode(input: {
    readonly originSessionId: string;
    readonly episodeId: string;
  }): EpisodeOperationResult;
  cancelEpisode(input: {
    readonly originSessionId: string;
    readonly episodeId: string;
    readonly reason?: string;
  }): Promise<EpisodeOperationResult>;
}

export interface CodexEpisodeRuntime {
  handleCodexOperation(input: {
    readonly hook: unknown;
    readonly request: unknown;
    readonly approval?: unknown;
  }): Promise<EpisodeOperationResult>;
  handleDiscordMessage(input: unknown): Promise<DiscordMessageResult>;
  close(): void;
}

interface InternalEpisodeModule extends EpisodeModule {
  findByOrigin(originSessionId: string): EpisodeView | undefined;
}

interface EpisodeRow {
  readonly id: string;
  readonly origin_session_id: string;
  readonly owner_discord_user_id: string;
  readonly phase: EpisodePhase;
  readonly phase_version: number;
  readonly thread_id: string | null;
  readonly thread_url: string | null;
  readonly context_reference: string;
  readonly context_digest: string;
  readonly context_retention_deadline: string | null;
  readonly cancelled_at: string | null;
  readonly cancellation_reason: string | null;
  readonly agent_previous_response_id: string | null;
  readonly proposal_message_id: string | null;
  readonly proposal_revision_id: string | null;
  readonly proposal_digest: string | null;
}

export function createColoopRuntime(configuration: RuntimeConfiguration): CodexEpisodeRuntime {
  mkdirSyncParent(configuration.databasePath);
  const database = new DatabaseSync(configuration.databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(database);
  const now = configuration.now ?? (() => new Date());
  const createId = configuration.createId ?? randomUUID;
  const episodes = createEpisodeModule(database, configuration, now, createId);
  const discordTurnQueues = new Map<string, Promise<void>>();

  return {
    async handleCodexOperation(input: {
      readonly hook: unknown;
      readonly request: unknown;
      readonly approval?: unknown;
    }): Promise<EpisodeOperationResult> {
      const hook = parseTrustedHook(input.hook);
      if (!hook.ok) return hook;
      const request = parseCodexRequest(input.request);
      if (!request.ok) return request;
      if (hook.value.toolName !== `mcp__coloop__${request.value.operation}`) {
        return failure(
          "TRUSTED_TOOL_MISMATCH",
          "The trusted Codex hook does not match the requested Episode operation.",
        );
      }
      const replay = checkReplay(database, hook.value, request.value);
      if (replay !== undefined) return replay;
      let result: EpisodeOperationResult;
      switch (request.value.operation) {
        case "open_episode": {
          const existing = episodes.findByOrigin(hook.value.sessionId);
          if (existing !== undefined) {
            result = { ok: true, created: false, episode: existing };
            break;
          }
          const transcript = await captureTranscript(hook.value);
          if (!transcript.ok) {
            result = transcript;
            break;
          }
          if (
            !matchesOwnerApproval(
              input.approval,
              hook.value.toolUseId,
              "open_episode",
              openApprovalDigest(request.value.arguments, transcript.contextMarkdown),
            )
          ) {
            result = failure(
              "APPROVAL_REQUIRED",
              "Opening a Collaboration Episode requires approval of the exact Context Package and Opening Brief.",
            );
            break;
          }
          if (lastOwnerText(transcript.messages) !== request.value.arguments.originalRequest) {
            result = failure(
              "ORIGINAL_REQUEST_MISMATCH",
              "The approved original request does not match the current trusted transcript.",
            );
            break;
          }
          const credentialFinding = findCredential(
            `${transcript.contextMarkdown}\n${request.value.arguments.openingBrief}`,
          );
          if (credentialFinding !== undefined) {
            result = failure(
              "CREDENTIAL_DETECTED",
              `Opening blocked: remove the credential-like value ${credentialFinding}.`,
            );
            break;
          }
          result = await episodes.openEpisode({
            originSessionId: hook.value.sessionId,
            originTurnId: hook.value.turnId,
            originalQuestion: request.value.arguments.originalRequest,
            openingBrief: request.value.arguments.openingBrief,
            contextMarkdown: transcript.contextMarkdown,
          });
          break;
        }
        case "get_episode":
          result = episodes.getEpisode({
            originSessionId: hook.value.sessionId,
            episodeId: request.value.arguments.episodeId,
          });
          break;
        case "cancel_episode": {
          if (
            !matchesOwnerApproval(
              input.approval,
              hook.value.toolUseId,
              "cancel_episode",
              cancellationApprovalDigest(request.value.arguments),
            )
          ) {
            result = failure(
              "APPROVAL_REQUIRED",
              "Cancelling a Collaboration Episode requires approval of the exact cancellation request.",
            );
            break;
          }
          result = await episodes.cancelEpisode({
            originSessionId: hook.value.sessionId,
            episodeId: request.value.arguments.episodeId,
            ...(request.value.arguments.reason === undefined
              ? {}
              : { reason: request.value.arguments.reason }),
          });
          break;
        }
      }
      if (result.ok && request.value.operation !== "get_episode") {
        recordCompletedOperation(database, hook.value, request.value, result.episode.id, now());
      }
      return result;
    },
    async handleDiscordMessage(input): Promise<DiscordMessageResult> {
      const event = parseDiscordMessageEvent(input);
      if (!event.ok) return event;
      return await serializeDiscordTurn(
        discordTurnQueues,
        `${event.value.guildId}:${event.value.threadId}`,
        async () =>
          await processDiscordMessage(
            database,
            configuration,
            event.value,
            now,
            createId,
          ),
      );
    },
    close(): void {
      database.close();
    },
  };
}

function parseDiscordMessageEvent(
  value: unknown,
):
  | { readonly ok: true; readonly value: DiscordMessageEvent }
  | { readonly ok: false; readonly reason: string; readonly code: string } {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.guildId) ||
    !isNonEmptyString(value.threadId) ||
    !isDiscordMessageAuthor(value.authorKind) ||
    (value.authorDiscordUserId !== undefined &&
      !isNonEmptyString(value.authorDiscordUserId)) ||
    !isNonEmptyString(value.content) ||
    typeof value.mentionsApplication !== "boolean"
  ) {
    return invalidDiscordEvent();
  }
  let relevantConversation: DiscordConversationMessage[] | undefined;
  if (value.relevantConversation !== undefined) {
    if (!Array.isArray(value.relevantConversation)) return invalidDiscordEvent();
    relevantConversation = [];
    for (const message of value.relevantConversation) {
      if (
        !isRecord(message) ||
        !isParticipantAuthor(message.authorKind) ||
        !isNonEmptyString(message.content)
      ) {
        return invalidDiscordEvent();
      }
      relevantConversation.push({
        authorKind: message.authorKind,
        content: message.content,
      });
    }
    const triggeringMessage = relevantConversation.at(-1);
    if (
      value.authorKind !== "coloop" &&
      (triggeringMessage?.authorKind !== value.authorKind ||
        triggeringMessage.content !== value.content)
    ) {
      return invalidDiscordEvent();
    }
  }
  return {
    ok: true,
    value: {
      eventId: value.eventId,
      guildId: value.guildId,
      threadId: value.threadId,
      authorKind: value.authorKind,
      ...(value.authorDiscordUserId === undefined
        ? {}
        : { authorDiscordUserId: value.authorDiscordUserId }),
      content: value.content,
      mentionsApplication: value.mentionsApplication,
      ...(relevantConversation === undefined ? {} : { relevantConversation }),
    },
  };
}

function isDiscordMessageAuthor(
  value: unknown,
): value is DiscordMessageEvent["authorKind"] {
  return value === "human" || isParticipantAuthor(value) || value === "coloop";
}

function isParticipantAuthor(
  value: unknown,
): value is DiscordConversationMessage["authorKind"] {
  return value === "human" || value === "external-bot" || value === "webhook";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalidDiscordEvent(): {
  readonly ok: false;
  readonly reason: string;
  readonly code: string;
} {
  return failure(
    "INVALID_DISCORD_EVENT",
    "The Discord message event is unsupported or malformed.",
  );
}

async function serializeDiscordTurn<Value>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  queues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

async function processDiscordMessage(
  database: DatabaseSync,
  configuration: RuntimeConfiguration,
  input: DiscordMessageEvent,
  now: () => Date,
  createId: () => string,
): Promise<DiscordMessageResult> {
  if (!input.mentionsApplication || input.authorKind === "coloop") {
    return { ok: true, status: "ignored" };
  }
  const episode = findActiveByDiscord(database, input.guildId, input.threadId);
  if (episode === undefined) return { ok: true, status: "ignored" };

  const replayDigest = digest(JSON.stringify(input));
  const replay = findProviderInput(database, input.eventId);
  if (replay !== undefined) {
    if (replay !== replayDigest) {
      return failure(
        "DISCORD_EVENT_REUSE",
        "The Discord event identity was reused with different input.",
      );
    }
    return { ok: true, status: "duplicate" };
  }

  const requestsSynthesis = requestsOutcomeProposal(input.content);
  const requestsRevision = requestsProposalRevision(input.content);
  if (requestsSynthesis && episode.proposal_revision_id === null) {
    if (input.authorDiscordUserId !== episode.owner_discord_user_id) {
      return failure(
        "OWNER_REQUIRED",
        "Only the paired Owner can request the first Outcome Proposal.",
      );
    }
    return await synthesizeOutcomeProposal(
      database,
      configuration,
      episode,
      input,
      now,
      createId,
    );
  }
  if (requestsRevision && episode.proposal_revision_id !== null) {
    return await synthesizeOutcomeProposal(
      database,
      configuration,
      episode,
      input,
      now,
      createId,
    );
  }

  const inputDigest = replayDigest;
  const receivedAt = now().toISOString();
  inTransaction(database, () => {
    database
      .prepare(
        `INSERT INTO provider_inbox (
          provider_event_id, episode_id, input_digest, effect_kind, status, received_at
        ) VALUES (?, ?, ?, 'agent_turn', 'PROCESSING', ?)`,
      )
      .run(input.eventId, episode.id, inputDigest, receivedAt);
    database
      .prepare(
        `INSERT INTO recovery_outbox (
          action_id, episode_id, sequence, action_kind, idempotency_key,
          destination_reference, state, payload, created_at
        ) VALUES (?, ?, (
          SELECT COALESCE(MAX(sequence), 0) + 1 FROM recovery_outbox WHERE episode_id = ?
        ), 'DISCORD_AGENT_RESPONSE', ?, ?, 'PENDING', NULL, ?)`,
      )
      .run(
        randomUUID(),
        episode.id,
        episode.id,
        `agent-response:${input.eventId}`,
        input.threadId,
        receivedAt,
      );
  });

  if (configuration.agent === undefined) {
    abandonAgentTurn(database, input.eventId);
    return failure("AGENT_UNAVAILABLE", "The Episode Agent is not configured.");
  }

  let response: Awaited<ReturnType<DiscordEpisodeTransport["beginAgentResponse"]>>;
  try {
    response = await configuration.discord.beginAgentResponse({
      eventId: input.eventId,
      guildId: input.guildId,
      threadId: input.threadId,
    });
  } catch {
    abandonAgentTurn(database, input.eventId);
    return failure("DISCORD_DELIVERY_FAILED", "Discord response delivery failed.");
  }

  const contextPackage = await readFile(episode.context_reference, "utf8");
  const agentResult = await configuration.agent.streamResponse({
    contextPackage,
    message: renderDiscordConversation(input),
    ...(episode.agent_previous_response_id === null
      ? {}
      : { previousResponseId: episode.agent_previous_response_id }),
    onTextDelta: async (delta) => {
      try {
        await response.appendText(delta);
        return { ok: true };
      } catch {
        return { ok: false, reason: "delivery-failed" };
      }
    },
  });
  if (!agentResult.ok) {
    abandonAgentTurn(database, input.eventId);
    return agentResult.reason === "delivery-failed"
      ? failure("DISCORD_DELIVERY_FAILED", "Discord response delivery failed.")
      : failure("AGENT_PROVIDER_FAILED", "The Episode Agent provider call failed.");
  }
  try {
    await response.complete();
  } catch {
    abandonAgentTurn(database, input.eventId);
    return failure("DISCORD_DELIVERY_FAILED", "Discord response delivery failed.");
  }

  const completedAt = now().toISOString();
  inTransaction(database, () => {
    database
      .prepare(
        "UPDATE episodes SET agent_previous_response_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(agentResult.responseId, completedAt, episode.id);
    database
      .prepare(
        `UPDATE provider_inbox SET status = 'COMPLETED', completed_at = ?
         WHERE provider_event_id = ?`,
      )
      .run(completedAt, input.eventId);
    database
      .prepare(
        `UPDATE recovery_outbox SET state = 'ACKNOWLEDGED', acknowledged_at = ?
         WHERE idempotency_key = ?`,
      )
      .run(completedAt, `agent-response:${input.eventId}`);
  });
  return { ok: true, status: "completed" };
}

function requestsOutcomeProposal(content: string): boolean {
  return (
    (/\boutcome\s+proposal\b/i.test(content) &&
      /\b(synthesize|create|draft|prepare|publish|make)\b/i.test(content)) ||
    (/\b(synthesize|summarize|turn|convert)\b/i.test(content) &&
      /\b(discussion|conversation|this)\b/i.test(content) &&
      /\b(recommendation|conclusion|result)\b/i.test(content))
  );
}

function requestsProposalRevision(content: string): boolean {
  return (
    /\b(revise|update|correct|change|amend|restore|fix|replace|make)\b/i.test(
      content,
    ) &&
    (/\boutcome\s+proposal\b/i.test(content) ||
      /\b(recommendation|conclusion|result|rollout|proposal)\b/i.test(content))
  );
}

type OutcomeProposalCandidate = OutcomeProposalContent;

async function synthesizeOutcomeProposal(
  database: DatabaseSync,
  configuration: RuntimeConfiguration,
  episode: EpisodeRow,
  input: DiscordMessageEvent,
  now: () => Date,
  createId: () => string,
): Promise<DiscordMessageResult> {
  const inputDigest = digest(JSON.stringify(input));
  if (configuration.agent === undefined) {
    return failure("AGENT_UNAVAILABLE", "The Episode Agent is not configured.");
  }

  const receivedAt = now().toISOString();
  const revisionId = createId();
  const isRevision = episode.proposal_revision_id !== null;
  const effectKind = isRevision ? "proposal_revision" : "proposal_synthesis";
  const actionKind = isRevision
    ? "DISCORD_PROPOSAL_REVISION"
    : "DISCORD_PROPOSAL_PUBLISH";
  inTransaction(database, () => {
    database
      .prepare(
        `INSERT INTO provider_inbox (
          provider_event_id, episode_id, input_digest, effect_kind, status, received_at
        ) VALUES (?, ?, ?, ?, 'PROCESSING', ?)`,
      )
      .run(input.eventId, episode.id, inputDigest, effectKind, receivedAt);
    database
      .prepare(
        `INSERT INTO recovery_outbox (
          action_id, episode_id, sequence, action_kind, idempotency_key,
          destination_reference, state, payload, created_at
        ) VALUES (?, ?, (
          SELECT COALESCE(MAX(sequence), 0) + 1 FROM recovery_outbox WHERE episode_id = ?
        ), ?, ?, ?, 'PENDING', NULL, ?)`,
      )
      .run(
        randomUUID(),
        episode.id,
        episode.id,
        actionKind,
        `proposal:${input.eventId}`,
        input.threadId,
        receivedAt,
      );
  });

  const candidateResult = await configuration.agent.synthesizeOutcomeProposal({
    contextPackage: await readFile(episode.context_reference, "utf8"),
    message: renderDiscordConversation(input),
    ...(episode.agent_previous_response_id === null
      ? {}
      : { previousResponseId: episode.agent_previous_response_id }),
  });
  if (!candidateResult.ok) {
    abandonProposal(database, input.eventId);
    return failure("AGENT_PROVIDER_FAILED", "The Episode Agent provider call failed.");
  }
  const candidate = parseOutcomeProposalCandidate(candidateResult.candidate);
  if (candidate === undefined) {
    abandonProposal(database, input.eventId);
    return failure(
      "INVALID_PROPOSAL_OUTPUT",
      "The Episode Agent did not return a valid Outcome Proposal.",
    );
  }

  const proposalDigest = digest(JSON.stringify(candidate));
  let delivery: ProposalDeliveryReceipt;
  try {
    if (episode.proposal_message_id === null) {
      delivery = await configuration.discord.publishOutcomeProposal({
        eventId: input.eventId,
        guildId: input.guildId,
        threadId: input.threadId,
        revisionId,
        resultMarkdown: candidate.resultMarkdown,
        unresolvedPoints: candidate.unresolvedPoints,
        contentSha256: proposalDigest,
        finalizationEnabled: true,
      });
    } else {
      delivery = await configuration.discord.reviseOutcomeProposal({
        eventId: input.eventId,
        guildId: input.guildId,
        threadId: input.threadId,
        messageId: episode.proposal_message_id,
        revisionId,
        resultMarkdown: candidate.resultMarkdown,
        unresolvedPoints: candidate.unresolvedPoints,
        contentSha256: proposalDigest,
        acknowledgement: `Outcome Proposal revised to ${revisionId}.`,
      });
    }
  } catch {
    abandonProposal(database, input.eventId);
    return failure("DISCORD_DELIVERY_FAILED", "Discord proposal delivery failed.");
  }
  const expectedMessageId = episode.proposal_message_id ?? delivery.messageId;
  if (
    delivery.messageId !== expectedMessageId ||
    delivery.revisionId !== revisionId ||
    delivery.contentSha256 !== proposalDigest
  ) {
    abandonProposal(database, input.eventId);
    return failure(
      "STALE_PROPOSAL_DELIVERY",
      "Discord did not acknowledge the current Outcome Proposal revision.",
    );
  }

  const completedAt = now().toISOString();
  // Discord must acknowledge the exact content before it becomes current locally.
  // A failed compare-and-set leaves the connected-only Episode unsafe to continue;
  // later interruption handling owns that fail-closed boundary.
  inTransaction(database, () => {
    const proposalUpdate =
      episode.proposal_revision_id === null
        ? database
            .prepare(
              `UPDATE episodes SET proposal_message_id = ?, proposal_revision_id = ?,
               proposal_digest = ?, agent_previous_response_id = ?, updated_at = ?
               WHERE id = ? AND phase = 'ACTIVE' AND proposal_revision_id IS NULL`,
            )
            .run(
              delivery.messageId,
              revisionId,
              proposalDigest,
              candidateResult.responseId,
              completedAt,
              episode.id,
            )
        : database
            .prepare(
              `UPDATE episodes SET proposal_revision_id = ?, proposal_digest = ?,
               agent_previous_response_id = ?, updated_at = ?
               WHERE id = ? AND phase = 'ACTIVE' AND proposal_revision_id = ?`,
            )
            .run(
              revisionId,
              proposalDigest,
              candidateResult.responseId,
              completedAt,
              episode.id,
              episode.proposal_revision_id,
            );
    if (proposalUpdate.changes !== 1) {
      throw new Error("The current Outcome Proposal changed during delivery.");
    }
    database
      .prepare(
        `UPDATE provider_inbox SET status = 'COMPLETED', completed_at = ?
         WHERE provider_event_id = ?`,
      )
      .run(completedAt, input.eventId);
    database
      .prepare(
        `UPDATE recovery_outbox SET state = 'ACKNOWLEDGED', acknowledged_at = ?
         WHERE idempotency_key = ?`,
      )
      .run(completedAt, `proposal:${input.eventId}`);
  });
  return { ok: true, status: "completed" };
}

function parseOutcomeProposalCandidate(value: unknown): OutcomeProposalCandidate | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !isNonBlankString(value.resultMarkdown) ||
    !Array.isArray(value.unresolvedPoints) ||
    !value.unresolvedPoints.every(isNonBlankString)
  ) {
    return undefined;
  }
  return {
    resultMarkdown: value.resultMarkdown,
    unresolvedPoints: value.unresolvedPoints,
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function abandonProposal(database: DatabaseSync, eventId: string): void {
  abandonProviderEffect(database, eventId, `proposal:${eventId}`);
}

function abandonAgentTurn(database: DatabaseSync, eventId: string): void {
  abandonProviderEffect(database, eventId, `agent-response:${eventId}`);
}

function abandonProviderEffect(
  database: DatabaseSync,
  eventId: string,
  idempotencyKey: string,
): void {
  inTransaction(database, () => {
    database
      .prepare("UPDATE provider_inbox SET status = 'FAILED' WHERE provider_event_id = ?")
      .run(eventId);
    database
      .prepare("UPDATE recovery_outbox SET state = 'ABANDONED' WHERE idempotency_key = ?")
      .run(idempotencyKey);
  });
}

function renderDiscordConversation(input: DiscordMessageEvent): string {
  if (input.relevantConversation === undefined) return input.content;
  return (
    "# Relevant Discord conversation\n\n" +
    input.relevantConversation
      .map((message) => `${message.authorKind}: ${message.content}`)
      .join("\n\n")
  );
}

function createEpisodeModule(
  database: DatabaseSync,
  configuration: RuntimeConfiguration,
  now: () => Date,
  createId: () => string,
): InternalEpisodeModule {
  return {
    openEpisode: (input) => openEpisode(database, configuration, now, createId, input),
    getEpisode: (input) => getEpisode(database, input.originSessionId, input.episodeId),
    cancelEpisode: (input) => cancelEpisode(database, configuration, now, input),
    findByOrigin: (originSessionId) => {
      const row = findByOrigin(database, originSessionId);
      return row === undefined ? undefined : toView(row);
    },
  };
}

async function openEpisode(
  database: DatabaseSync,
  configuration: RuntimeConfiguration,
  now: () => Date,
  createId: () => string,
  input: Parameters<EpisodeModule["openEpisode"]>[0],
): Promise<EpisodeOperationResult> {
  const existing = findByOrigin(database, input.originSessionId);
  if (existing !== undefined) return { ok: true, created: false, episode: toView(existing) };

  const episodeId = createId();
  const episodeDirectory = resolve(configuration.artifactDirectory, episodeId);
  const contextReference = join(episodeDirectory, "context.md");
  await mkdir(episodeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(contextReference, input.contextMarkdown, { mode: 0o600, flag: "wx" });
  await chmod(contextReference, 0o400);
  const contextDigest = digest(input.contextMarkdown);
  const createdAt = now().toISOString();

  try {
    inTransaction(database, () => {
      database
        .prepare(
          `INSERT INTO episodes (
            id, origin_session_id, origin_turn_id, owner_discord_user_id, guild_id,
            parent_channel_id, phase, phase_version, original_question, opening_brief,
            context_reference, context_digest, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'OPENING', 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episodeId,
          input.originSessionId,
          input.originTurnId,
          configuration.ownerDiscordUserId,
          configuration.guildId,
          configuration.parentChannelId,
          input.originalQuestion,
          input.openingBrief,
          contextReference,
          contextDigest,
          createdAt,
          createdAt,
        );
      addAudit(database, episodeId, 1, "EPISODE_OPENING", "owner", createdAt);
      addPendingOpeningOutbox(
        database,
        episodeId,
        configuration.parentChannelId,
        createdAt,
      );
    });
  } catch (error) {
    const winner = findByOrigin(database, input.originSessionId);
    if (winner === undefined) throw error;
    if (winner.id !== episodeId) {
      await rm(episodeDirectory, { recursive: true, force: true });
    }
    return { ok: true, created: false, episode: toView(winner) };
  }

  let provisioned: Awaited<
    ReturnType<DiscordEpisodeTransport["provisionEpisode"]>
  >;
  try {
    provisioned = await configuration.discord.provisionEpisode({
      idempotencyKey: `episode-opened:${episodeId}`,
      guildId: configuration.guildId,
      parentChannelId: configuration.parentChannelId,
      ownerDiscordUserId: configuration.ownerDiscordUserId,
      episodeId,
      openingBrief: input.openingBrief,
    });
  } catch {
    return failure(
      "DISCORD_PROVISIONING_FAILED",
      `Episode ${episodeId} remains OPENING because Discord provisioning failed.`,
    );
  }

  const activatedAt = now().toISOString();
  inTransaction(database, () => {
    const activation = database
      .prepare(
        `UPDATE episodes SET phase = 'ACTIVE', phase_version = 2, thread_id = ?,
         thread_url = ?, updated_at = ? WHERE id = ? AND phase = 'OPENING'`,
      )
      .run(provisioned.threadId, provisioned.threadUrl, activatedAt, episodeId);
    acknowledgeOpeningOutbox(database, episodeId, provisioned.threadId, activatedAt);
    if (activation.changes === 1) {
      addAudit(database, episodeId, 2, "EPISODE_ACTIVATED", "discord", activatedAt);
      return;
    }
    const winner = findById(database, episodeId);
    if (winner?.phase === "CANCELLED") {
      addPendingCancellationOutbox(database, episodeId, provisioned.threadId, activatedAt);
    }
  });
  const row = findById(database, episodeId);
  if (row === undefined) throw new Error("Activated Episode was not found.");
  if (row.phase === "CANCELLED") {
    const delivery = await deliverPendingCancellation(database, configuration, row, now);
    if (delivery !== undefined) return delivery;
  }
  return { ok: true, created: true, episode: toView(row) };
}

function getEpisode(
  database: DatabaseSync,
  originSessionId: string,
  episodeId: string,
): EpisodeOperationResult {
  const row = findById(database, episodeId);
  if (row === undefined || row.origin_session_id !== originSessionId) {
    return failure("EPISODE_NOT_FOUND", "No Episode is available to this Origin Session.");
  }
  return { ok: true, episode: toView(row) };
}

async function cancelEpisode(
  database: DatabaseSync,
  configuration: RuntimeConfiguration,
  now: () => Date,
  input: Parameters<EpisodeModule["cancelEpisode"]>[0],
): Promise<EpisodeOperationResult> {
  const row = findById(database, input.episodeId);
  if (row === undefined || row.origin_session_id !== input.originSessionId) {
    return failure("EPISODE_NOT_FOUND", "No Episode is available to this Origin Session.");
  }
  if (row.phase === "FINALIZED") {
    return { ok: true, episode: toView(row) };
  }
  if (row.phase === "CANCELLED") {
    const delivery = await deliverPendingCancellation(database, configuration, row, now);
    return delivery ?? { ok: true, episode: toView(row) };
  }
  const cancelledAt = now().toISOString();
  const retentionDeadline = new Date(
    new Date(cancelledAt).getTime() + contextPackageRetentionMs,
  ).toISOString();
  let transitioned = false;
  inTransaction(database, () => {
    const update = database
      .prepare(
        `UPDATE episodes SET phase = 'CANCELLED', phase_version = phase_version + 1,
         cancelled_at = ?, cancellation_reason = ?, context_retention_deadline = ?, updated_at = ?
         WHERE id = ? AND phase IN ('OPENING', 'ACTIVE')`,
      )
      .run(
        cancelledAt,
        input.reason ?? null,
        retentionDeadline,
        cancelledAt,
        row.id,
      );
    if (update.changes !== 1) return;
    transitioned = true;
    addAudit(
      database,
      row.id,
      row.phase_version + 1,
      "EPISODE_CANCELLED",
      "owner",
      cancelledAt,
    );
    if (row.thread_id !== null) {
      addPendingCancellationOutbox(database, row.id, row.thread_id, cancelledAt);
    }
  });
  if (!transitioned) {
    const winner = findById(database, row.id);
    if (winner === undefined) throw new Error("Terminal Episode was not found.");
    if (winner.phase === "CANCELLED") {
      const delivery = await deliverPendingCancellation(database, configuration, winner, now);
      if (delivery !== undefined) return delivery;
    }
    return { ok: true, episode: toView(winner) };
  }
  const cancelled = findById(database, row.id);
  if (cancelled === undefined) throw new Error("Cancelled Episode was not found.");
  const delivery = await deliverPendingCancellation(database, configuration, cancelled, now);
  if (delivery !== undefined) return delivery;
  return { ok: true, episode: toView(cancelled) };
}

type CapturedMessage =
  | { readonly author: "owner"; readonly text: string }
  | { readonly author: "codex"; readonly phase: "commentary" | "final_answer"; readonly text: string };

async function captureTranscript(
  hook: TrustedHook,
): Promise<
  | { readonly ok: true; readonly messages: readonly CapturedMessage[]; readonly contextMarkdown: string }
  | { readonly ok: false; readonly reason: string; readonly code: string }
> {
  let source: string;
  try {
    source = await readFile(hook.transcriptPath, "utf8");
  } catch {
    return failure("TRANSCRIPT_UNREADABLE", "The trusted Codex transcript cannot be read.");
  }
  const lines = source.trim().split("\n");
  const records: unknown[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      return failure("UNSUPPORTED_TRANSCRIPT", "The Codex transcript is not valid JSONL.");
    }
  }
  const metadata = records.shift();
  if (!isSessionMetadata(metadata, hook.sessionId)) {
    return failure(
      "UNSUPPORTED_TRANSCRIPT",
      "The transcript session or Codex CLI provenance is unsupported.",
    );
  }
  const messages: CapturedMessage[] = [];
  let trustedTurnFound = false;
  let trustedToolFound = false;
  for (const record of records) {
    if (isRecord(record) && record.type === "turn_context" && isRecord(record.payload)) {
      if (record.payload.turn_id === hook.turnId) trustedTurnFound = true;
      else if (typeof record.payload.turn_id !== "string") {
        return failure("UNSUPPORTED_TRANSCRIPT", "A transcript turn has no trusted identity.");
      }
      continue;
    }
    if (isTrustedToolCall(record, hook)) {
      trustedToolFound = true;
      break;
    }
    const parsed = parseVisibleRecord(record);
    if (parsed === "excluded") continue;
    if (parsed === undefined) {
      return failure(
        "UNSUPPORTED_TRANSCRIPT",
        "The transcript contains an unsupported or ambiguous visible record.",
      );
    }
    messages.push(parsed);
  }
  if (!trustedTurnFound) {
    return failure(
      "UNSUPPORTED_TRANSCRIPT",
      "The trusted Codex turn is not present in the transcript.",
    );
  }
  if (!trustedToolFound) {
    return failure(
      "UNSUPPORTED_TRANSCRIPT",
      "The trusted Codex tool invocation is not present in the transcript.",
    );
  }
  if (messages.length === 0 || !messages.some((message) => message.author === "owner")) {
    return failure("UNSUPPORTED_TRANSCRIPT", "The transcript has no visible Owner request.");
  }
  return { ok: true, messages, contextMarkdown: renderContext(messages) };
}

function parseVisibleRecord(record: unknown): CapturedMessage | "excluded" | undefined {
  if (!isRecord(record) || !isRecord(record.payload)) return undefined;
  if (record.type === "event_msg" && record.payload.type === "user_message") {
    return (record.payload.provenance === undefined || record.payload.provenance === "owner") &&
      typeof record.payload.message === "string" &&
      record.payload.message.length > 0
      ? { author: "owner", text: record.payload.message }
      : undefined;
  }
  if (record.type === "response_item" && record.payload.type === "message") {
    if (record.payload.role === "system" || record.payload.role === "developer") return "excluded";
    if (
      record.payload.role !== "assistant" ||
      (record.payload.phase !== "commentary" && record.payload.phase !== "final_answer") ||
      !Array.isArray(record.payload.content) ||
      record.payload.content.length !== 1
    ) {
      return undefined;
    }
    const content = record.payload.content[0];
    return isRecord(content) &&
      content.type === "output_text" &&
      typeof content.text === "string"
      ? {
          author: "codex",
          phase: record.payload.phase,
          text: content.text,
        }
      : undefined;
  }
  if (
    record.type === "response_item" &&
    (record.payload.type === "reasoning" ||
      record.payload.type === "function_call" ||
      record.payload.type === "function_call_output")
  ) {
    return "excluded";
  }
  if (record.type === "event_msg" && record.payload.type === "token_count") return "excluded";
  return undefined;
}

function renderContext(messages: readonly CapturedMessage[]): string {
  const sections = messages.map((message) => {
    if (message.author === "owner") return `## Owner\n\n${message.text}`;
    return `## Codex ${message.phase === "final_answer" ? "final" : "commentary"}\n\n${message.text}`;
  });
  return `# Collaboration Episode Context\n\n${sections.join("\n\n")}\n`;
}

function lastOwnerText(messages: readonly CapturedMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author === "owner") return message.text;
  }
  return undefined;
}

function findCredential(content: string): string | undefined {
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bAKIA[A-Z0-9]{16}\b/g,
    /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content)?.[0];
    if (match !== undefined) return `${match.slice(0, 3)}…${match.slice(-4)}`;
  }
  return undefined;
}

function parseTrustedHook(
  value: unknown,
):
  | { readonly ok: true; readonly value: TrustedHook }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (
    !isRecord(value) ||
    !isRecord(value.client) ||
    value.client.name !== "codex-cli" ||
    value.client.version !== "0.150.1" ||
    !isRecord(value.payload) ||
    value.payload.hook_event_name !== "PreToolUse" ||
    typeof value.payload.session_id !== "string" ||
    value.payload.session_id.length === 0 ||
    typeof value.payload.turn_id !== "string" ||
    value.payload.turn_id.length === 0 ||
    typeof value.payload.tool_use_id !== "string" ||
    value.payload.tool_use_id.length === 0 ||
    typeof value.payload.tool_name !== "string" ||
    value.payload.tool_name.length === 0 ||
    typeof value.payload.transcript_path !== "string" ||
    value.payload.transcript_path.length === 0
  ) {
    return failure(
      "UNSUPPORTED_CODEX_CLIENT",
      "A trusted Codex CLI 0.150.1 pre-tool hook is required.",
    );
  }
  return {
    ok: true,
    value: {
      event: value.payload.hook_event_name,
      client: value.client.name,
      clientVersion: value.client.version,
      sessionId: value.payload.session_id,
      turnId: value.payload.turn_id,
      toolUseId: value.payload.tool_use_id,
      toolName: value.payload.tool_name,
      transcriptPath: value.payload.transcript_path,
    },
  };
}

function isTrustedToolCall(value: unknown, hook: TrustedHook): boolean {
  return (
    isRecord(value) &&
    value.type === "response_item" &&
    isRecord(value.payload) &&
    value.payload.type === "function_call" &&
    value.payload.call_id === hook.toolUseId &&
    value.payload.name === hook.toolName
  );
}

function parseCodexRequest(
  value: unknown,
):
  | { readonly ok: true; readonly value: CodexRequest }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (!isRecord(value) || !isRecord(value.arguments)) return invalidOperation();
  if (
    value.operation === "open_episode" &&
    typeof value.arguments.openingBrief === "string" &&
    typeof value.arguments.originalRequest === "string"
  ) {
    return {
      ok: true,
      value: {
        operation: "open_episode",
        arguments: {
          openingBrief: value.arguments.openingBrief,
          originalRequest: value.arguments.originalRequest,
        },
      },
    };
  }
  if (value.operation === "get_episode" && typeof value.arguments.episodeId === "string") {
    return {
      ok: true,
      value: { operation: "get_episode", arguments: { episodeId: value.arguments.episodeId } },
    };
  }
  if (
    value.operation === "cancel_episode" &&
    typeof value.arguments.episodeId === "string" &&
    (value.arguments.reason === undefined || typeof value.arguments.reason === "string")
  ) {
    return {
      ok: true,
      value: {
        operation: "cancel_episode",
        arguments: {
          episodeId: value.arguments.episodeId,
          ...(value.arguments.reason === undefined ? {} : { reason: value.arguments.reason }),
        },
      },
    };
  }
  return invalidOperation();
}

type OpenEpisodeApprovalInput = {
  readonly toolUseId: string;
  readonly operation: "open_episode";
  readonly contextMarkdown: string;
} & EpisodeToolArguments["open_episode"];

type CancelEpisodeApprovalInput = {
  readonly toolUseId: string;
  readonly operation: "cancel_episode";
} & EpisodeToolArguments["cancel_episode"];

export function createOwnerApproval(input: OpenEpisodeApprovalInput): object;
export function createOwnerApproval(input: CancelEpisodeApprovalInput): object;
export function createOwnerApproval(
  input: OpenEpisodeApprovalInput | CancelEpisodeApprovalInput,
): object {
  const inputDigest =
    input.operation === "open_episode"
      ? openApprovalDigest(input, input.contextMarkdown)
      : cancellationApprovalDigest(input);
  return {
    source: "trusted_owner_approval",
    toolUseId: input.toolUseId,
    operation: input.operation,
    inputDigest,
  };
}

function cancellationApprovalDigest(
  input: EpisodeToolArguments["cancel_episode"],
): string {
  return digest(
    JSON.stringify({
      episodeId: input.episodeId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  );
}

function openApprovalDigest(
  input: EpisodeToolArguments["open_episode"],
  contextMarkdown: string,
): string {
  return digest(
    JSON.stringify({
      openingBrief: input.openingBrief,
      originalRequest: input.originalRequest,
      contextPackageSha256: digest(contextMarkdown),
    }),
  );
}

function matchesOwnerApproval(
  value: unknown,
  toolUseId: string,
  operation: CodexRequest["operation"],
  inputDigest: string,
): boolean {
  return (
    isRecord(value) &&
    value.source === "trusted_owner_approval" &&
    value.toolUseId === toolUseId &&
    value.operation === operation &&
    value.inputDigest === inputDigest
  );
}

function invalidOperation(): { readonly ok: false; readonly code: string; readonly reason: string } {
  return failure(
    "INVALID_OPERATION",
    "The Codex Episode operation is unsupported or malformed.",
  );
}

function isSessionMetadata(value: unknown, sessionId: string): boolean {
  return (
    isRecord(value) &&
    value.type === "session_meta" &&
    isRecord(value.payload) &&
    value.payload.id === sessionId &&
    value.payload.source === "cli"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failure(code: string, reason: string): { readonly ok: false; readonly code: string; readonly reason: string } {
  return { ok: false, code, reason };
}

function findByOrigin(database: DatabaseSync, originSessionId: string): EpisodeRow | undefined {
  return parseEpisodeRow(
    database
    .prepare("SELECT * FROM episodes WHERE origin_session_id = ?")
      .get(originSessionId),
  );
}

function findById(database: DatabaseSync, episodeId: string): EpisodeRow | undefined {
  return parseEpisodeRow(
    database.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId),
  );
}

function findActiveByDiscord(
  database: DatabaseSync,
  guildId: string,
  threadId: string,
): EpisodeRow | undefined {
  return parseEpisodeRow(
    database
      .prepare(
        "SELECT * FROM episodes WHERE guild_id = ? AND thread_id = ? AND phase = 'ACTIVE'",
      )
      .get(guildId, threadId),
  );
}

function findProviderInput(
  database: DatabaseSync,
  providerEventId: string,
): string | undefined {
  const value = database
    .prepare("SELECT input_digest FROM provider_inbox WHERE provider_event_id = ?")
    .get(providerEventId);
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.input_digest !== "string") {
    throw new Error("Stored provider input is malformed.");
  }
  return value.input_digest;
}

function parseEpisodeRow(value: unknown): EpisodeRow | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.origin_session_id !== "string" ||
    typeof value.owner_discord_user_id !== "string" ||
    !isEpisodePhase(value.phase) ||
    typeof value.phase_version !== "number" ||
    !isNullableString(value.thread_id) ||
    !isNullableString(value.thread_url) ||
    typeof value.context_reference !== "string" ||
    typeof value.context_digest !== "string" ||
    !isNullableString(value.context_retention_deadline) ||
    !isNullableString(value.cancelled_at) ||
    !isNullableString(value.cancellation_reason) ||
    !isNullableString(value.agent_previous_response_id)
    || !isNullableString(value.proposal_message_id)
    || !isNullableString(value.proposal_revision_id)
    || !isNullableString(value.proposal_digest)
  ) {
    throw new Error("Stored Episode state is malformed.");
  }
  return {
    id: value.id,
    origin_session_id: value.origin_session_id,
    owner_discord_user_id: value.owner_discord_user_id,
    phase: value.phase,
    phase_version: value.phase_version,
    thread_id: value.thread_id,
    thread_url: value.thread_url,
    context_reference: value.context_reference,
    context_digest: value.context_digest,
    context_retention_deadline: value.context_retention_deadline,
    cancelled_at: value.cancelled_at,
    cancellation_reason: value.cancellation_reason,
    agent_previous_response_id: value.agent_previous_response_id,
    proposal_message_id: value.proposal_message_id,
    proposal_revision_id: value.proposal_revision_id,
    proposal_digest: value.proposal_digest,
  };
}

function isEpisodePhase(value: unknown): value is EpisodePhase {
  return (
    value === "OPENING" ||
    value === "ACTIVE" ||
    value === "FINALIZED" ||
    value === "CANCELLED"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function toView(row: EpisodeRow): EpisodeView {
  if (row.phase === "CANCELLED") {
    if (row.cancelled_at === null) throw new Error("Cancelled Episode has no terminal timestamp.");
    return {
      id: row.id,
      phase: "CANCELLED",
      cancellation: {
        cancelledAt: row.cancelled_at,
        ...(row.cancellation_reason === null ? {} : { reason: row.cancellation_reason }),
      },
    };
  }
  if (row.phase === "FINALIZED") return { id: row.id, phase: "FINALIZED" };
  return {
    id: row.id,
    originSessionId: row.origin_session_id,
    phase: row.phase,
    ...(row.thread_url === null ? {} : { collaborationUrl: row.thread_url }),
    contextPackage: {
      reference: row.context_reference,
      sha256: row.context_digest,
    },
    ...(row.proposal_message_id === null ||
    row.proposal_revision_id === null ||
    row.proposal_digest === null
      ? {}
      : {
          outcomeProposal: {
            messageId: row.proposal_message_id,
            revisionId: row.proposal_revision_id,
            sha256: row.proposal_digest,
          },
        }),
  };
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY, origin_session_id TEXT NOT NULL UNIQUE, origin_turn_id TEXT NOT NULL,
      owner_discord_user_id TEXT NOT NULL, guild_id TEXT NOT NULL, parent_channel_id TEXT NOT NULL,
      thread_id TEXT, thread_url TEXT, phase TEXT NOT NULL, phase_version INTEGER NOT NULL,
      original_question TEXT NOT NULL, opening_brief TEXT NOT NULL, context_reference TEXT NOT NULL,
      context_digest TEXT NOT NULL, context_retention_deadline TEXT,
      cancelled_at TEXT, cancellation_reason TEXT, agent_previous_response_id TEXT,
      proposal_message_id TEXT, proposal_revision_id TEXT, proposal_digest TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_inbox (
      provider_event_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, input_digest TEXT NOT NULL,
      effect_kind TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS recovery_outbox (
      action_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      action_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, destination_reference TEXT NOT NULL,
      state TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, acknowledged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS episode_audit (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, phase_version INTEGER NOT NULL,
      transition_type TEXT NOT NULL, actor_kind TEXT NOT NULL, schema_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
  const episodeColumns = database
    .prepare("PRAGMA table_info(episodes)")
    .all()
    .filter(isRecord)
    .map((column) => column.name);
  if (!episodeColumns.includes("agent_previous_response_id")) {
    database.exec("ALTER TABLE episodes ADD COLUMN agent_previous_response_id TEXT");
  }
  if (!episodeColumns.includes("proposal_message_id")) {
    database.exec("ALTER TABLE episodes ADD COLUMN proposal_message_id TEXT");
  }
  if (!episodeColumns.includes("proposal_revision_id")) {
    database.exec("ALTER TABLE episodes ADD COLUMN proposal_revision_id TEXT");
  }
  if (!episodeColumns.includes("proposal_digest")) {
    database.exec("ALTER TABLE episodes ADD COLUMN proposal_digest TEXT");
  }
}

function addAudit(
  database: DatabaseSync,
  episodeId: string,
  phaseVersion: number,
  transitionType: string,
  actorKind: string,
  occurredAt: string,
): void {
  database
    .prepare(
      "INSERT INTO episode_audit VALUES (?, ?, ?, ?, ?, 1, ?)",
    )
    .run(randomUUID(), episodeId, phaseVersion, transitionType, actorKind, occurredAt);
}

function addPendingOpeningOutbox(
  database: DatabaseSync,
  episodeId: string,
  parentChannelId: string,
  occurredAt: string,
): void {
  database
    .prepare(
      `INSERT INTO recovery_outbox VALUES (?, ?, 1, 'DISCORD_EPISODE_OPENED', ?, ?,
       'PENDING', NULL, ?, NULL)`,
    )
    .run(
      randomUUID(),
      episodeId,
      `episode-opened:${episodeId}`,
      parentChannelId,
      occurredAt,
    );
}

function acknowledgeOpeningOutbox(
  database: DatabaseSync,
  episodeId: string,
  threadId: string,
  occurredAt: string,
): void {
  database
    .prepare(
      `UPDATE recovery_outbox SET destination_reference = ?, state = 'ACKNOWLEDGED',
       acknowledged_at = ? WHERE episode_id = ? AND action_kind = 'DISCORD_EPISODE_OPENED'
       AND state = 'PENDING'`,
    )
    .run(threadId, occurredAt, episodeId);
}

function addPendingCancellationOutbox(
  database: DatabaseSync,
  episodeId: string,
  threadId: string,
  occurredAt: string,
): void {
  database
    .prepare(
      `INSERT INTO recovery_outbox VALUES (?, ?, 2, 'DISCORD_EPISODE_CANCELLED', ?, ?,
       'PENDING', NULL, ?, NULL)`,
    )
    .run(
      randomUUID(),
      episodeId,
      `episode-cancelled:${episodeId}`,
      threadId,
      occurredAt,
    );
}

async function deliverPendingCancellation(
  database: DatabaseSync,
  configuration: RuntimeConfiguration,
  episode: EpisodeRow,
  now: () => Date,
): Promise<{ readonly ok: false; readonly code: string; readonly reason: string } | undefined> {
  const value = database
    .prepare(
      `SELECT action_id, idempotency_key, destination_reference FROM recovery_outbox
       WHERE episode_id = ? AND action_kind = 'DISCORD_EPISODE_CANCELLED' AND state = 'PENDING'`,
    )
    .get(episode.id);
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.action_id !== "string" ||
    typeof value.idempotency_key !== "string" ||
    typeof value.destination_reference !== "string"
  ) {
    return failure("DURABLE_STATE_INVALID", "The pending cancellation action is malformed.");
  }
  try {
    await configuration.discord.presentCancellation({
      idempotencyKey: value.idempotency_key,
      guildId: configuration.guildId,
      threadId: value.destination_reference,
      episodeId: episode.id,
      ...(episode.cancellation_reason === null
        ? {}
        : { reason: episode.cancellation_reason }),
    });
  } catch {
    return failure(
      "DISCORD_PRESENTATION_FAILED",
      `Episode ${episode.id} is CANCELLED; Discord terminal presentation remains pending.`,
    );
  }
  const acknowledgedAt = now().toISOString();
  database
    .prepare(
      `UPDATE recovery_outbox SET state = 'ACKNOWLEDGED', payload = NULL, acknowledged_at = ?
       WHERE action_id = ? AND state = 'PENDING'`,
    )
    .run(acknowledgedAt, value.action_id);
  return undefined;
}

function checkReplay(
  database: DatabaseSync,
  hook: TrustedHook,
  request: CodexRequest,
): { readonly ok: false; readonly code: string; readonly reason: string } | undefined {
  const value = database
    .prepare("SELECT input_digest FROM provider_inbox WHERE provider_event_id = ?")
    .get(providerEventId(hook, request));
  if (value !== undefined && (!isRecord(value) || typeof value.input_digest !== "string")) {
    return failure("DURABLE_STATE_INVALID", "The stored provider event is malformed.");
  }
  if (value !== undefined && value.input_digest !== digest(JSON.stringify(request))) {
    return failure(
      "REPLAY_INPUT_MISMATCH",
      "The trusted operation identity was reused with different input.",
    );
  }
  return undefined;
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function recordCompletedOperation(
  database: DatabaseSync,
  hook: TrustedHook,
  request: CodexRequest,
  episodeId: string,
  occurredAt: Date,
): void {
  const timestamp = occurredAt.toISOString();
  database
    .prepare(
      `INSERT INTO provider_inbox (
        provider_event_id, episode_id, input_digest, effect_kind, status, received_at, completed_at
      ) VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)
      ON CONFLICT(provider_event_id) DO UPDATE SET status = 'COMPLETED', completed_at = excluded.completed_at`,
    )
    .run(
      providerEventId(hook, request),
      episodeId,
      digest(JSON.stringify(request)),
      request.operation,
      timestamp,
      timestamp,
    );
}

function providerEventId(hook: TrustedHook, request: CodexRequest): string {
  return `${hook.sessionId}:${hook.toolUseId}:${request.operation}`;
}

function mkdirSyncParent(path: string): void {
  const parent = dirname(resolve(path));
  // DatabaseSync cannot create its parent. The product composition owns this local setup step.
  requireDirectory(parent);
}

function requireDirectory(path: string): void {
  const { mkdirSync } = process.getBuiltinModule("node:fs");
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
