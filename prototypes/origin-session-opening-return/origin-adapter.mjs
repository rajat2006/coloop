/**
 * Throwaway Origin Session adapter used by Wayfinder ticket 13.
 *
 * This is decision evidence, not production code. Its transcript parser is
 * pinned to the observed Codex rollout schema and fails closed on unknown
 * visible-message shapes.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

const VISIBLE_ASSISTANT_PHASES = new Set(["commentary", "final_answer"]);
const CONTROL_TOOLS = new Set([
  "mcp__coloop__open_episode",
  "mcp__coloop__get_episode",
  "mcp__coloop__cancel_episode",
]);

export class PrototypeError extends Error {}

function textParts(content, expectedType) {
  if (!Array.isArray(content)) {
    throw new PrototypeError("Unsupported transcript: message content is not a list.");
  }
  return content.map((item) => {
    if (!item || typeof item !== "object" || item.type !== expectedType) {
      throw new PrototypeError("Unsupported transcript: visible message has a non-text part.");
    }
    if (typeof item.text !== "string") {
      throw new PrototypeError("Unsupported transcript: visible message text is missing.");
    }
    return item.text;
  });
}

export function captureVisibleText(
  transcriptPath,
  expectedSessionId,
  throughTurnId,
) {
  if (!existsSync(transcriptPath)) {
    throw new PrototypeError(
      "Opening is unavailable: Codex supplied no readable transcript.",
    );
  }

  const sessionIds = new Set();
  const captured = [];
  let sawOpeningTurn = false;
  const lines = readFileSync(transcriptPath, "utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new PrototypeError(
        `Unsupported transcript: invalid JSON on line ${index + 1}.`,
        { cause: error },
      );
    }

    if (row.type === "session_meta") {
      if (typeof row.payload?.session_id === "string") {
        sessionIds.add(row.payload.session_id);
      }
      continue;
    }

    const payload = row.payload;
    if (row.type !== "response_item" || !payload || typeof payload !== "object") {
      continue;
    }
    if (payload.type !== "message") continue;

    const metadata = payload.internal_chat_message_metadata_passthrough;
    if (payload.role === "user") {
      if (!metadata || typeof metadata !== "object") {
        throw new PrototypeError(
          "Unsupported transcript: Owner message provenance is missing.",
        );
      }
      const kinds = metadata.content_item_kinds;
      if (!Array.isArray(kinds) || kinds.length === 0) {
        throw new PrototypeError(
          "Unsupported transcript: Owner message provenance is unknown.",
        );
      }
      if (!kinds.includes("user.text")) {
        // User-role records also carry injected AGENTS.md, environment, and
        // selected-skill instructions. Those are not Owner-visible text.
        continue;
      }
      if (kinds.some((kind) => kind !== "user.text")) {
        throw new PrototypeError(
          "Opening is unavailable: mixed text/attachment Owner messages are not supported.",
        );
      }
      const parts = textParts(payload.content, "input_text");
      if (parts.length !== kinds.length) {
        throw new PrototypeError(
          "Unsupported transcript: Owner text provenance is ambiguous.",
        );
      }
      captured.push(["Owner", parts.join("\n\n")]);
      if (metadata.turn_id === throughTurnId) sawOpeningTurn = true;
      continue;
    }

    if (payload.role === "assistant") {
      if (!VISIBLE_ASSISTANT_PHASES.has(payload.phase)) {
        throw new PrototypeError(
          `Unsupported transcript: unknown Codex message phase ${JSON.stringify(payload.phase)}.`,
        );
      }
      captured.push(["Codex", textParts(payload.content, "output_text").join("\n\n")]);
      continue;
    }

    // Developer messages are injected context. No other role is currently safe
    // to classify as visible Owner-Codex text.
    if (payload.role !== "developer") {
      throw new PrototypeError(
        `Unsupported transcript: unknown message role ${JSON.stringify(payload.role)}.`,
      );
    }
  }

  if (sessionIds.size !== 1 || !sessionIds.has(expectedSessionId)) {
    throw new PrototypeError(
      "Opening is unavailable: transcript/session identity mismatch.",
    );
  }
  if (!sawOpeningTurn) {
    throw new PrototypeError(
      "Opening is unavailable: approved opening request is not in the transcript.",
    );
  }
  if (captured.length === 0) {
    throw new PrototypeError(
      "Opening is unavailable: no visible Owner-Codex text was captured.",
    );
  }

  const markdown = captured
    .map(([speaker, text]) => `### ${speaker}\n\n${text}`)
    .join("\n\n");
  return {
    markdown,
    sha256: createHash("sha256").update(markdown).digest("hex"),
    messageCount: captured.length,
  };
}

const SECRET_PATTERNS = new Map([
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  ["GitHub token", /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}\b/gu],
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/gu],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
]);

export function credentialFindings(...texts) {
  const findings = [];
  for (const text of texts) {
    for (const [kind, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const value = match[0];
        const masked =
          value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "[masked]";
        findings.push({ kind, masked });
      }
    }
  }
  return findings;
}

export function rewritePreToolUse(event) {
  if (event.hook_event_name !== "PreToolUse") {
    throw new PrototypeError("Expected a PreToolUse hook event.");
  }
  if (!CONTROL_TOOLS.has(event.tool_name)) return {};
  if (typeof event.session_id !== "string" || !event.session_id) {
    throw new PrototypeError("Opening is unavailable: Codex hook identity is missing.");
  }
  if (typeof event.turn_id !== "string" || !event.turn_id) {
    throw new PrototypeError("Opening is unavailable: Codex turn identity is missing.");
  }
  if (!event.tool_input || typeof event.tool_input !== "object") {
    throw new PrototypeError("Coloop tool input is malformed.");
  }

  const updatedInput = {
    ...event.tool_input,
    _origin_session_id: event.session_id,
    _origin_turn_id: event.turn_id,
  };
  if (event.tool_name === "mcp__coloop__open_episode") {
    if (typeof event.transcript_path !== "string" || !event.transcript_path) {
      throw new PrototypeError(
        "Opening is unavailable: this Codex client supplied no transcript path.",
      );
    }
    updatedInput._origin_transcript_path = event.transcript_path;
  } else {
    delete updatedInput._origin_transcript_path;
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

const initialDatabase = () => ({ episodes: [] });

export class EpisodeStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    if (!existsSync(databasePath)) this.#write(initialDatabase());
  }

  #read() {
    return JSON.parse(readFileSync(this.databasePath, "utf8"));
  }

  #write(database) {
    const temporaryPath = `${this.databasePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.databasePath);
  }

  #view(episode, created) {
    const view = {
      episode_id: episode.episodeId,
      phase: episode.phase,
      discord_url: episode.discordUrl,
    };
    if (created !== undefined) view.created = created;
    if (episode.phase === "FINALIZED") {
      view.episode_outcome = structuredClone(episode.outcome);
    }
    if (episode.phase === "CANCELLED") view.cancel_reason = episode.cancelReason;
    return view;
  }

  #owned(database, sessionId, episodeId) {
    const episode = database.episodes.find((item) => item.episodeId === episodeId);
    if (!episode || episode.originSessionId !== sessionId) {
      throw new PrototypeError("Episode is not available to this Origin Session.");
    }
    return episode;
  }

  async openEpisode({
    sessionId,
    transcriptPath,
    openingTurnId,
    openingBriefMarkdown,
    ownerApproved,
    provisioningDelayMs = 35,
  }) {
    if (!ownerApproved) {
      throw new PrototypeError("Opening requires explicit Owner tool approval.");
    }
    const database = this.#read();
    const existing = database.episodes.find(
      (episode) => episode.originSessionId === sessionId,
    );
    if (existing) return this.#view(existing, false);

    const capture = captureVisibleText(transcriptPath, sessionId, openingTurnId);
    const findings = credentialFindings(capture.markdown, openingBriefMarkdown);
    if (findings.length > 0) {
      const summary = findings.map(({ kind, masked }) => `${kind} ${masked}`).join(", ");
      throw new PrototypeError(
        `Opening blocked: remove high-confidence credential(s): ${summary}`,
      );
    }

    const episode = {
      episodeId: `ep_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      originSessionId: sessionId,
      phase: "OPENING",
      discordUrl: null,
      openingBrief: openingBriefMarkdown,
      contextPackage: capture.markdown,
      contextSha256: capture.sha256,
      outcome: null,
      cancelReason: null,
      pending: false,
      deliveredTurnId: null,
      provisioningMs: null,
    };
    database.episodes.push(episode);
    this.#write(database);

    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, provisioningDelayMs));
    const elapsedMs = Math.round(performance.now() - started);
    const current = this.#read();
    const stored = this.#owned(current, sessionId, episode.episodeId);
    if (stored.phase === "OPENING") {
      stored.phase = "ACTIVE";
      stored.discordUrl =
        `https://discord.com/channels/prototype/episodes/${stored.episodeId}`;
      stored.provisioningMs = elapsedMs;
      this.#write(current);
    }
    const view = this.#view(stored, true);
    view.capture = {
      message_count: capture.messageCount,
      sha256: capture.sha256,
    };
    view.provisioning_ms = elapsedMs;
    return view;
  }

  getEpisode(sessionId, episodeId) {
    const database = this.#read();
    return this.#view(this.#owned(database, sessionId, episodeId));
  }

  cancelEpisode(sessionId, episodeId, ownerApproved, reason = null) {
    if (!ownerApproved) {
      throw new PrototypeError("Cancellation requires explicit Owner tool approval.");
    }
    const database = this.#read();
    const episode = this.#owned(database, sessionId, episodeId);
    if (["FINALIZED", "CANCELLED"].includes(episode.phase)) return this.#view(episode);
    episode.phase = "CANCELLED";
    episode.cancelReason = reason;
    episode.contextPackage = null;
    episode.pending = false;
    this.#write(database);
    return this.#view(episode);
  }

  finalizeFromDiscord(
    episodeId,
    actorDiscordId,
    ownerDiscordId,
    result,
    unresolvedPoints,
  ) {
    if (actorDiscordId !== ownerDiscordId) {
      throw new PrototypeError("Only the paired Owner can Finalize and Return.");
    }
    const database = this.#read();
    const episode = database.episodes.find((item) => item.episodeId === episodeId);
    if (!episode) throw new PrototypeError("Episode does not exist.");
    if (episode.phase === "FINALIZED" || episode.phase !== "ACTIVE") {
      return this.#view(episode);
    }
    // One atomic file replacement records the terminal phase, exact Outcome,
    // and pending return together.
    episode.phase = "FINALIZED";
    episode.outcome = { result, unresolved_points: unresolvedPoints };
    episode.pending = true;
    episode.contextPackage = null;
    this.#write(database);
    return this.#view(episode);
  }

  injectPendingOutcome(sessionId, turnId) {
    const database = this.#read();
    const episode = database.episodes.find(
      (item) => item.originSessionId === sessionId,
    );
    if (!episode || episode.phase !== "FINALIZED" || !episode.pending) return null;
    const context =
      "A Collaboration Episode finalized for this Origin Session. Before handling " +
      "the Owner's new request, present this exact accepted Episode Outcome without " +
      "paraphrasing:\n\n" +
      `Result:\n${episode.outcome.result}\n\n` +
      `Unresolved points:\n${episode.outcome.unresolved_points}`;
    episode.pending = false;
    episode.deliveredTurnId = turnId;
    this.#write(database);
    return context;
  }
}

export function userPromptSubmitOutput(store, event) {
  if (event.hook_event_name !== "UserPromptSubmit") {
    throw new PrototypeError("Expected a UserPromptSubmit hook event.");
  }
  if (typeof event.session_id !== "string" || typeof event.turn_id !== "string") {
    throw new PrototypeError("Codex hook identity is missing.");
  }
  const additionalContext = store.injectPendingOutcome(
    event.session_id,
    event.turn_id,
  );
  if (additionalContext === null) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}
