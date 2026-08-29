#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EpisodeStore,
  PrototypeError,
  rewritePreToolUse,
  userPromptSubmitOutput,
} from "./origin-adapter.mjs";

const SESSION = "thr_owner_origin";
const OTHER_SESSION = "thr_other_conversation";
const OPENING_TURN = "turn_open";
const OWNER_ID = "discord_owner_42";

function message(role, text, { turnId, kind, phase } = {}) {
  const payload = {
    type: "message",
    role,
    content: [
      { type: role === "user" ? "input_text" : "output_text", text },
    ],
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId,
      content_item_kinds: [kind ?? "unknown"],
    },
  };
  if (phase) payload.phase = phase;
  return { type: "response_item", payload };
}

function writeTranscript(path, includeSecret = false) {
  const rows = [
    { type: "session_meta", payload: { session_id: SESSION } },
    message("user", "Injected workspace instructions.", {
      turnId: "turn_1",
      kind: "agents_md.instructions",
    }),
    message("user", "Help me choose a launch plan.", {
      turnId: "turn_1",
      kind: "user.text",
    }),
    message("assistant", "Compare a narrow beta with a broad launch.", {
      turnId: "turn_1",
      phase: "final_answer",
    }),
    { type: "response_item", payload: { type: "reasoning", summary: ["hidden"] } },
    { type: "response_item", payload: { type: "function_call", name: "secret_tool" } },
    message(
      "user",
      "Open a Collaboration Episode for beta feedback." +
        (includeSecret ? " sk-prototypecredential123456789" : ""),
      { turnId: OPENING_TURN, kind: "user.text" },
    ),
    message("assistant", "Opening Brief preview: challenge the beta criteria.", {
      turnId: OPENING_TURN,
      phase: "commentary",
    }),
  ];
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function runHook(event, databasePath) {
  if (event.hook_event_name === "PreToolUse") return rewritePreToolUse(event);
  if (event.hook_event_name === "UserPromptSubmit") {
    return userPromptSubmitOutput(new EpisodeStore(databasePath), event);
  }
  throw new PrototypeError(`Unsupported hook event ${event.hook_event_name}.`);
}

function check(name, condition, detail) {
  return { name, passed: Boolean(condition), detail };
}

const directory = mkdtempSync(join(tmpdir(), "coloop-origin-prototype-"));
const results = [];
try {
  const transcriptPath = join(directory, "rollout.jsonl");
  const databasePath = join(directory, "PROTOTYPE-wipe-me.json");
  writeTranscript(transcriptPath);
  const store = new EpisodeStore(databasePath);

  const preTool = runHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__coloop__open_episode",
      tool_input: { opening_brief_markdown: "**Question:** Challenge the narrow beta." },
      session_id: SESSION,
      turn_id: OPENING_TURN,
      transcript_path: transcriptPath,
    },
    databasePath,
  );
  const rewritten = preTool.hookSpecificOutput.updatedInput;
  results.push(
    check(
      "hook injects trusted identity",
      rewritten._origin_session_id === SESSION &&
        rewritten._origin_transcript_path === transcriptPath,
      "The PreToolUse hook logic overwrote internal Origin Session fields.",
    ),
  );

  const opened = await store.openEpisode({
    sessionId: rewritten._origin_session_id,
    transcriptPath: rewritten._origin_transcript_path,
    openingTurnId: rewritten._origin_turn_id,
    openingBriefMarkdown: rewritten.opening_brief_markdown,
    ownerApproved: true,
  });
  results.push(
    check(
      "synchronous opening returns ACTIVE",
      opened.phase === "ACTIVE" && opened.created === true,
      { provisioning_ms: opened.provisioning_ms, phase: opened.phase },
    ),
  );
  results.push(
    check(
      "visible-text capture excludes injected/tool/reasoning records",
      opened.capture.message_count === 4,
      opened.capture,
    ),
  );

  const duplicate = await store.openEpisode({
    sessionId: SESSION,
    transcriptPath,
    openingTurnId: OPENING_TURN,
    openingBriefMarkdown: "A replacement that must be ignored.",
    ownerApproved: true,
  });
  results.push(
    check(
      "repeat opening is idempotent",
      duplicate.episode_id === opened.episode_id && duplicate.created === false,
      "Same Episode returned unchanged with created: false.",
    ),
  );

  let crossSessionBlocked = false;
  try {
    store.getEpisode(OTHER_SESSION, opened.episode_id);
  } catch (error) {
    crossSessionBlocked = error instanceof PrototypeError;
  }
  results.push(
    check(
      "different Origin Session cannot retrieve",
      crossSessionBlocked,
      "Cross-session lookup failed closed.",
    ),
  );

  const finalized = store.finalizeFromDiscord(
    opened.episode_id,
    OWNER_ID,
    OWNER_ID,
    "Run a two-week beta with five maintainers.",
    "Choose the support channel owner.",
  );
  const repeatedFinalization = store.finalizeFromDiscord(
    opened.episode_id,
    OWNER_ID,
    OWNER_ID,
    "Attempted replacement.",
    "Attempted replacement.",
  );
  results.push(
    check(
      "finalization is immutable",
      JSON.stringify(finalized) === JSON.stringify(repeatedFinalization) &&
        finalized.episode_outcome.result ===
          "Run a two-week beta with five maintainers.",
      "Repeated finalization retained the first exact Outcome.",
    ),
  );

  const wrongHook = runHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: OTHER_SESSION,
      turn_id: "turn_wrong",
      prompt: "Anything new?",
    },
    databasePath,
  );
  const correctHook = runHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      turn_id: "turn_return",
      prompt: "Now draft the launch checklist.",
    },
    databasePath,
  );
  const repeatedHook = runHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      turn_id: "turn_return",
      prompt: "Now draft the launch checklist.",
    },
    databasePath,
  );
  const injected = correctHook.hookSpecificOutput.additionalContext;
  results.push(
    check(
      "outcome waits for the same Origin Session's next turn",
      Object.keys(wrongHook).length === 0 &&
        injected.includes("Run a two-week beta with five maintainers.") &&
        injected.includes("Choose the support channel owner."),
      "Wrong session received nothing; bound session received exact result and unresolved points.",
    ),
  );
  results.push(
    check(
      "return injection is at most once",
      Object.keys(repeatedHook).length === 0,
      "Repeated UserPromptSubmit produced no second injection.",
    ),
  );
  results.push(
    check(
      "get_episode remains a fallback",
      JSON.stringify(store.getEpisode(SESSION, opened.episode_id)) ===
        JSON.stringify(finalized),
      "Retrieval returned the same immutable Episode Outcome after injection.",
    ),
  );
  results.push(
    check(
      "late cancellation cannot replace finalization",
      JSON.stringify(
        store.cancelEpisode(SESSION, opened.episode_id, true, "Too late"),
      ) === JSON.stringify(finalized),
      "Late cancellation returned the unchanged FINALIZED Episode.",
    ),
  );

  const secretTranscript = join(directory, "secret-rollout.jsonl");
  const secretDatabase = join(directory, "secret-PROTOTYPE-wipe-me.json");
  writeTranscript(secretTranscript, true);
  const secretStore = new EpisodeStore(secretDatabase);
  let credentialBlocked = false;
  let credentialDetail = "not blocked";
  try {
    await secretStore.openEpisode({
      sessionId: SESSION,
      transcriptPath: secretTranscript,
      openingTurnId: OPENING_TURN,
      openingBriefMarkdown: "Challenge the narrow beta.",
      ownerApproved: true,
    });
  } catch (error) {
    credentialDetail = error instanceof Error ? error.message : String(error);
    credentialBlocked =
      credentialDetail.includes("sk-p…6789") &&
      !credentialDetail.includes("prototypecredential");
  }
  results.push(
    check(
      "credential preflight blocks with masked finding",
      credentialBlocked,
      credentialDetail,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const evidence = {
  status: results.every((item) => item.passed) ? "passed" : "failed",
  runtime: process.version,
  checks: results,
  notes: [
    "Discord provisioning is a measured local stand-in, not a live Discord API call.",
    "Hook payload and transcript shape are pinned to the documented/observed Codex schema.",
    "The clickable HTML walkthrough is the human-feedback surface.",
  ],
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (evidence.status !== "passed") process.exitCode = 1;
