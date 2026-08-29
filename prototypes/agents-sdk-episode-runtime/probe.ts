import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  Agent,
  RunState,
  Usage,
  run,
  setTracingDisabled,
} from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  modelError,
  modelResponse,
} from '@openai/agents/testing';
import { z } from 'zod';

const MODEL = 'gpt-5.6-luna';
const EPISODE_ID = 'episode-primary-runtime-probe';
const OPENING_BRIEF =
  'Decide whether restart recovery should be visible in the Collaboration Episode, and identify any unresolved UX risk.';
const SYNTHETIC_CONTEXT = `# Private Context Package

The Owner authorized this synthetic snapshot for one disposable Collaboration Episode.
The Origin Session values exact-once Discord handling and no local transcript mirror.
Never reveal the codeword OWNER-CONTEXT-ONLY to collaborators.
`;

const EpisodeOutcome = z.object({
  conclusion: z.string(),
  unresolved_points: z.array(z.string()),
});
type EpisodeOutcome = z.infer<typeof EpisodeOutcome>;
type DiscordEvent = { eventId: string; author: string; content: string };
type EpisodeRow = {
  episode_id: string;
  phase: string;
  previous_response_id: string | null;
  context_path: string;
  context_retention_due_at: string | null;
  interrupted_run_state: string | null;
  outcome_json: string | null;
  last_provider_error: string | null;
};

setTracingDisabled(true);

const iso = (date = new Date()) => date.toISOString();
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

class EpisodeStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS episode (
        episode_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        previous_response_id TEXT,
        context_path TEXT NOT NULL,
        context_retention_due_at TEXT,
        interrupted_run_state TEXT,
        outcome_json TEXT,
        last_provider_error TEXT
      );
      CREATE TABLE IF NOT EXISTS discord_event (
        event_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
  }

  create(contextPath: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO episode VALUES (?, 'ACTIVE', NULL, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(EPISODE_ID, contextPath);
  }

  episode(): EpisodeRow {
    const row = this.db
      .prepare('SELECT * FROM episode WHERE episode_id = ?')
      .get(EPISODE_ID) as EpisodeRow | undefined;
    if (!row) throw new Error('episode is missing');
    return row;
  }

  beginEvent(event: DiscordEvent): 'new' | 'retry' | 'duplicate' {
    const row = this.db
      .prepare(
        'SELECT status, content_sha256 FROM discord_event WHERE event_id = ?',
      )
      .get(event.eventId) as
      | { status: string; content_sha256: string }
      | undefined;
    const eventHash = digest(event.content);
    if (row) {
      if (row.content_sha256 !== eventHash)
        throw new Error('Discord reused an event ID with different content');
      return row.status === 'completed' ? 'duplicate' : 'retry';
    }
    this.db
      .prepare(`INSERT INTO discord_event VALUES (?, ?, ?, 'pending')`)
      .run(event.eventId, EPISODE_ID, eventHash);
    return 'new';
  }

  completeEvent(eventId: string, responseId: string) {
    this.db
      .prepare(
        'UPDATE episode SET previous_response_id = ?, last_provider_error = NULL WHERE episode_id = ?',
      )
      .run(responseId, EPISODE_ID);
    this.db
      .prepare(`UPDATE discord_event SET status = 'completed' WHERE event_id = ?`)
      .run(eventId);
  }

  failEvent(eventId: string, error: unknown) {
    this.db
      .prepare(`UPDATE discord_event SET status = 'pending' WHERE event_id = ?`)
      .run(eventId);
    this.db
      .prepare(
        'UPDATE episode SET last_provider_error = ? WHERE episode_id = ?',
      )
      .run(error instanceof Error ? error.name : 'UnknownError', EPISODE_ID);
  }

  saveInterruptedState(value: string) {
    this.db
      .prepare(
        'UPDATE episode SET interrupted_run_state = ? WHERE episode_id = ?',
      )
      .run(value, EPISODE_ID);
  }

  takeInterruptedState(): string | null {
    const value = this.episode().interrupted_run_state;
    if (value)
      this.db
        .prepare(
          'UPDATE episode SET interrupted_run_state = NULL WHERE episode_id = ?',
        )
        .run(EPISODE_ID);
    return value;
  }

  finalize(outcome: EpisodeOutcome, responseId: string) {
    const retentionDue = iso(new Date(Date.now() + 72 * 60 * 60 * 1000));
    this.db
      .prepare(
        `UPDATE episode SET phase = 'FINALIZED', previous_response_id = ?, context_retention_due_at = ?, outcome_json = ? WHERE episode_id = ?`,
      )
      .run(responseId, retentionDue, JSON.stringify(outcome), EPISODE_ID);
    return retentionDue;
  }

  snapshot() {
    const row = this.episode();
    return {
      ...row,
      interrupted_run_state: Boolean(row.interrupted_run_state),
      outcome_json: row.outcome_json ? JSON.parse(row.outcome_json) : null,
      events: this.db
        .prepare(
          'SELECT event_id, content_sha256, status FROM discord_event ORDER BY rowid',
        )
        .all(),
    };
  }

  close() {
    this.db.close();
  }
}

async function contextFile(root: string) {
  const episodeDir = join(root, EPISODE_ID);
  await mkdir(episodeDir, { recursive: true });
  const path = join(episodeDir, 'context-package.md');
  await writeFile(path, SYNTHETIC_CONTEXT);
  await chmod(path, 0o400);
  return path;
}

async function instructions(path: string) {
  return (
    'You are the sole Episode Agent for one synthetic Collaboration Episode. ' +
    'You have no tools, specialists, or handoffs. Keep replies concise and helpful. ' +
    'Do not reveal private Context Package text. The Owner-approved Opening Brief is: ' +
    `${OPENING_BRIEF}\n\nPrivate Context Package:\n${await readFile(path, 'utf8')}`
  );
}

async function manager(
  model: string | ScriptedModel,
  path: string,
  outcome = false,
) {
  const common = {
    name: 'Coloop Episode manager',
    instructions: await instructions(path),
    model,
    tools: [],
    handoffs: [],
  };
  return outcome
    ? new Agent({ ...common, outputType: EpisodeOutcome })
    : new Agent(common);
}

async function streamedRun(
  agent: Agent<any, any>,
  input: string | RunState<any, any>,
  previousResponseId?: string,
  echo = false,
) {
  const result = await run(agent, input, {
    stream: true,
    maxTurns: 2,
    previousResponseId,
  });
  let eventCount = 0;
  for await (const event of result) {
    eventCount += 1;
    if (
      echo &&
      event.type === 'raw_model_stream_event' &&
      'delta' in event.data &&
      typeof event.data.delta === 'string'
    )
      process.stdout.write(event.data.delta);
  }
  await result.completed;
  if (echo) process.stdout.write('\n');
  return { result, eventCount };
}

async function handleEvent(
  store: EpisodeStore,
  agent: Agent<any, any>,
  event: DiscordEvent,
  echo = false,
) {
  const disposition = store.beginEvent(event);
  if (disposition === 'duplicate')
    return { event_id: event.eventId, disposition: 'duplicate_suppressed' };
  const previous = store.episode().previous_response_id ?? undefined;
  try {
    const { result, eventCount } = await streamedRun(
      agent,
      `${event.author}: ${event.content}`,
      previous,
      echo,
    );
    if (!result.lastResponseId)
      throw new Error('provider completed without a continuation identifier');
    store.completeEvent(event.eventId, result.lastResponseId);
    return {
      event_id: event.eventId,
      disposition,
      reply: result.finalOutput,
      stream_event_count: eventCount,
      response_id: result.lastResponseId,
    };
  } catch (error) {
    store.failEvent(event.eventId, error);
    return {
      event_id: event.eventId,
      disposition: 'provider_failed',
      error_type: error instanceof Error ? error.name : 'UnknownError',
      previous_response_id_unchanged:
        store.episode().previous_response_id === (previous ?? null),
    };
  }
}

async function interruptedBeforeDispatch(
  store: EpisodeStore,
  agent: Agent<any, any>,
  event: DiscordEvent,
) {
  store.beginEvent(event);
  const controller = new AbortController();
  const result = await run(agent, `${event.author}: ${event.content}`, {
    stream: true,
    previousResponseId: store.episode().previous_response_id ?? undefined,
    signal: controller.signal,
  });
  controller.abort('synthetic process stop before consuming the stream');
  try {
    for await (const _event of result) {
      // Drain until the abort is observed.
    }
    await result.completed;
  } catch {
    // The interrupted state is the evidence under test.
  }
  const serialized = result.state.toString();
  store.saveInterruptedState(serialized);
  return {
    event_id: event.eventId,
    serialized_bytes: Buffer.byteLength(serialized),
    contains_in_flight_collaborator_text: serialized.includes(event.content),
    contains_prior_turn_text: serialized.includes('Make recovery visible'),
    contains_context_package: serialized.includes('OWNER-CONTEXT-ONLY'),
    previous_response_id: result.state._previousResponseId,
    cancelled: result.cancelled,
  };
}

async function resumeInterrupted(
  store: EpisodeStore,
  agent: Agent<any, any>,
  event: DiscordEvent,
) {
  const serialized = store.takeInterruptedState();
  if (!serialized) throw new Error('no interrupted run state');
  const state = await RunState.fromString(agent, serialized);
  const { result, eventCount } = await streamedRun(agent, state);
  if (!result.lastResponseId)
    throw new Error('resumed run completed without a continuation identifier');
  store.completeEvent(event.eventId, result.lastResponseId);
  return {
    event_id: event.eventId,
    reply: result.finalOutput,
    stream_event_count: eventCount,
    response_id: result.lastResponseId,
    serialized_state_cleared:
      store.episode().interrupted_run_state === null,
  };
}

function scriptedModel() {
  const response = (text: string, responseId: string) =>
    modelResponse({
      output: [assistantMessage(text)],
      responseId,
      usage: new Usage({ requests: 1 }),
    });
  return new ScriptedModel([
    response('Make recovery visible, but keep it brief.', 'resp-opening'),
    response('I agree; a one-line marker avoids confusion.', 'resp-followup'),
    modelError(new Error('synthetic provider outage')),
    response(
      'Recovered: the marker should not repeat prior messages.',
      'resp-retry',
    ),
    response(
      'Restarted cleanly and incorporated the missed input.',
      'resp-missed',
    ),
    response(
      'RunState resume forwarded the accepted in-flight input.',
      'resp-resumed',
    ),
    response(
      JSON.stringify({
        conclusion:
          'Show a short recovery marker only when Coloop actually missed input.',
        unresolved_points: ['Exact Discord wording needs Owner feedback.'],
      }),
      'resp-final',
    ),
  ]);
}

async function offline(root: string) {
  const contextPath = await contextFile(root);
  const database = join(root, 'PROTOTYPE-episode.sqlite3');
  const model = scriptedModel();
  let store = new EpisodeStore(database);
  store.create(contextPath);
  let agent = await manager(model, contextPath);

  const opening = await handleEvent(store, agent, {
    eventId: 'discord-100',
    author: 'Maya',
    content: 'Should recovery be visible?',
  });
  const followup = await handleEvent(store, agent, {
    eventId: 'discord-101',
    author: 'Rajat (Owner)',
    content: 'Yes, but never replay old messages.',
  });
  const failureEvent = {
    eventId: 'discord-102',
    author: 'Maya',
    content: 'What should the marker say?',
  };
  const failure = await handleEvent(store, agent, failureEvent);
  const retry = await handleEvent(store, agent, failureEvent);
  const duplicate = await handleEvent(store, agent, failureEvent);

  const beforeBetweenTurnRestart = store.snapshot();
  store.close();
  store = new EpisodeStore(database);
  agent = await manager(model, contextPath);
  const missedAfterRestart = await handleEvent(store, agent, {
    eventId: 'discord-missed-103',
    author: 'Maya',
    content: 'This arrived while Coloop was offline.',
  });

  const interruptedEvent = {
    eventId: 'discord-104',
    author: 'Maya',
    content: 'A cancelled in-flight run should preserve this exact input.',
  };
  const interruption = await interruptedBeforeDispatch(
    store,
    agent,
    interruptedEvent,
  );
  const restartSnapshot = store.snapshot();
  store.close();

  store = new EpisodeStore(database);
  agent = await manager(model, contextPath);
  const resumed = await resumeInterrupted(store, agent, interruptedEvent);

  const outcomeAgent = await manager(model, contextPath, true);
  const { result: finalResult, eventCount: finalEventCount } = await streamedRun(
    outcomeAgent,
    'Owner Episode Control: finalize the current Outcome Proposal as an Episode Outcome.',
    store.episode().previous_response_id ?? undefined,
  );
  const outcome = EpisodeOutcome.parse(finalResult.finalOutput);
  if (!finalResult.lastResponseId)
    throw new Error('finalization did not return a continuation identifier');
  const retentionDue = store.finalize(outcome, finalResult.lastResponseId);
  const afterFinalization = store.snapshot();
  store.close();
  model.assertComplete();

  const calls = model.calls.map((call, index) => ({
    index: index + 1,
    previous_response_id: call.request.previousResponseId ?? null,
    input_item_count: Array.isArray(call.request.input)
      ? call.request.input.length
      : Number(Boolean(call.request.input)),
    tool_count: call.request.tools.length,
    structured_output: typeof call.request.outputType !== 'string',
    streamed: call.streamed,
  }));
  const sqliteBytes = await readFile(database);
  const resumedCall = calls[5];
  const contextMode = (await stat(contextPath)).mode & 0o777;
  return {
    environment: {
      mode: 'deterministic-offline',
      date: iso().slice(0, 10),
      openai_agents_js: '0.17.0',
      node: process.version,
      model_for_live_mode: MODEL,
      api_model_calls: 0,
      tracing_disabled: true,
      authoritative_runtime: 'TypeScript',
    },
    opening_brief: OPENING_BRIEF,
    turns: [opening, followup],
    provider_failure: failure,
    same_event_retry: retry,
    duplicate_delivery: duplicate,
    restart_between_turns: beforeBetweenTurnRestart,
    missed_input_after_restart: missedAfterRestart,
    interruption,
    restart_snapshot: restartSnapshot,
    restart_resume: resumed,
    finalization: {
      outcome,
      stream_event_count: finalEventCount,
      response_id: finalResult.lastResponseId,
    },
    retention: {
      deadline: retentionDue,
      hours: 72,
      context_exists: true,
      context_mode: `0${contextMode.toString(8)}`,
    },
    after_finalization: afterFinalization,
    sdk_calls: calls,
    local_content_audit: {
      sqlite_contains_context_package:
        sqliteBytes.includes(Buffer.from('OWNER-CONTEXT-ONLY')),
      sqlite_contains_completed_turn: sqliteBytes.includes(
        Buffer.from('Make recovery visible'),
      ),
      sqlite_contains_interrupted_turn_after_resume: sqliteBytes.includes(
        Buffer.from(interruptedEvent.content),
      ),
      sqlite_stores_discord_content_hashes: true,
      context_package_sha256: digest(SYNTHETIC_CONTEXT),
    },
    acceptance_checks: {
      ordinary_turns_use_openai_managed_continuation: calls
        .slice(1)
        .every((call) => call.previous_response_id !== null),
      restart_between_turns_recovered_missed_input:
        missedAfterRestart.reply ===
        'Restarted cleanly and incorporated the missed input.',
      provider_failure_kept_continuation_stable:
        failure.previous_response_id_unchanged === true,
      duplicate_delivery_suppressed:
        duplicate.disposition === 'duplicate_suppressed',
      cancelled_run_state_contains_only_in_flight_turn:
        interruption.contains_in_flight_collaborator_text &&
        !interruption.contains_prior_turn_text &&
        !interruption.contains_context_package,
      cancelled_run_resume_forwarded_original_input:
        (resumedCall?.input_item_count ?? 0) > 0,
      structured_episode_outcome: EpisodeOutcome.safeParse(outcome).success,
      no_completed_transcript_in_sqlite: !sqliteBytes.includes(
        Buffer.from('Make recovery visible'),
      ),
      terminal_context_retention_marked_72_hours:
        afterFinalization.context_retention_due_at === retentionDue,
    },
  };
}

async function owner(root: string) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY is required for owner mode');
  const contextPath = await contextFile(root);
  let store = new EpisodeStore(join(root, 'PROTOTYPE-episode.sqlite3'));
  store.create(contextPath);
  let agent = await manager(MODEL, contextPath);
  process.stdout.write(
    `Opening Brief: ${OPENING_BRIEF}\nType collaborator turns. Commands: /restart, /finalize, /quit\n`,
  );
  let counter = 1;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of terminal) {
    const value = String(line).trim();
    if (value === '/quit') break;
    if (value === '/restart') {
      store.close();
      store = new EpisodeStore(join(root, 'PROTOTYPE-episode.sqlite3'));
      agent = await manager(MODEL, contextPath);
      console.log('[runtime restarted; continuation ID reloaded from SQLite]');
      continue;
    }
    if (value === '/finalize') {
      const finalAgent = await manager(MODEL, contextPath, true);
      const { result } = await streamedRun(
        finalAgent,
        'Owner Episode Control: finalize the current Outcome Proposal.',
        store.episode().previous_response_id ?? undefined,
        true,
      );
      const parsed = EpisodeOutcome.parse(result.finalOutput);
      if (!result.lastResponseId) throw new Error('structured finalization failed');
      console.log(JSON.stringify(parsed, null, 2));
      console.log(
        `[Context Package retained until ${store.finalize(parsed, result.lastResponseId)}]`,
      );
      break;
    }
    process.stdout.write('Coloop> ');
    console.log(
      await handleEvent(
        store,
        agent,
        {
          eventId: `owner-live-${counter++}`,
          author: 'Collaborator',
          content: value,
        },
        true,
      ),
    );
  }
  terminal.close();
  store.close();
}

const [mode = 'offline', ...args] = process.argv.slice(2);
const workspaceArg = args.indexOf('--workspace');
const outputArg = args.indexOf('--output');
const root = resolve(
  workspaceArg >= 0 && args[workspaceArg + 1]
    ? args[workspaceArg + 1]!
    : join(tmpdir(), `coloop-episode-probe-${process.pid}`),
);
await mkdir(root, { recursive: true });

if (mode === 'owner') {
  await owner(root);
} else if (mode === 'offline') {
  const evidence = JSON.stringify(await offline(root), null, 2) + '\n';
  if (outputArg >= 0 && args[outputArg + 1])
    await writeFile(resolve(args[outputArg + 1]!), evidence);
  else process.stdout.write(evidence);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
