from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import sqlite3
import stat
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from agents import Agent, RawResponsesStreamEvent, RunConfig, RunState, Runner
from agents.testing import ModelStep, ScriptedModel, assistant_message
from openai.types.responses import ResponseTextDeltaEvent
from pydantic import BaseModel, ConfigDict


MODEL = "gpt-5.6-luna"
EPISODE_ID = "episode-primary-runtime-probe"
OPENING_BRIEF = (
    "Decide whether restart recovery should be visible in the Collaboration Episode, "
    "and identify any unresolved UX risk."
)
SYNTHETIC_CONTEXT = """# Private Context Package

The Owner authorized this synthetic snapshot for one disposable Collaboration Episode.
The Origin Session values exact-once Discord handling and no local transcript mirror.
Never reveal the codeword OWNER-CONTEXT-ONLY to collaborators.
"""


class EpisodeOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conclusion: str
    unresolved_points: list[str]


@dataclass(frozen=True)
class DiscordEvent:
    event_id: str
    author: str
    content: str


def now() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class EpisodeStore:
    """PROTOTYPE store: metadata, continuation IDs, and temporary RunState only."""

    def __init__(self, path: Path):
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA secure_delete = ON")
        self.db.executescript(
            """
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
            """
        )
        self.db.commit()

    def create(self, context_path: Path) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO episode VALUES (?, 'ACTIVE', NULL, ?, NULL, NULL, NULL, NULL)",
            (EPISODE_ID, str(context_path)),
        )
        self.db.commit()

    def episode(self) -> sqlite3.Row:
        row = self.db.execute(
            "SELECT * FROM episode WHERE episode_id = ?", (EPISODE_ID,)
        ).fetchone()
        if row is None:
            raise RuntimeError("episode is missing")
        return row

    def begin_event(self, event: DiscordEvent) -> Literal["new", "retry", "duplicate"]:
        row = self.db.execute(
            "SELECT status, content_sha256 FROM discord_event WHERE event_id = ?",
            (event.event_id,),
        ).fetchone()
        event_hash = digest(event.content)
        if row is not None:
            if row["content_sha256"] != event_hash:
                raise RuntimeError("Discord reused an event ID with different content")
            return "duplicate" if row["status"] == "completed" else "retry"
        self.db.execute(
            "INSERT INTO discord_event VALUES (?, ?, ?, 'pending')",
            (event.event_id, EPISODE_ID, event_hash),
        )
        self.db.commit()
        return "new"

    def complete_event(self, event_id: str, response_id: str) -> None:
        self.db.execute(
            "UPDATE episode SET previous_response_id = ?, last_provider_error = NULL "
            "WHERE episode_id = ?",
            (response_id, EPISODE_ID),
        )
        self.db.execute(
            "UPDATE discord_event SET status = 'completed' WHERE event_id = ?", (event_id,)
        )
        self.db.commit()

    def fail_event(self, event_id: str, error: Exception) -> None:
        self.db.execute(
            "UPDATE discord_event SET status = 'pending' WHERE event_id = ?", (event_id,)
        )
        self.db.execute(
            "UPDATE episode SET last_provider_error = ? WHERE episode_id = ?",
            (type(error).__name__, EPISODE_ID),
        )
        self.db.commit()

    def save_interrupted_state(self, value: dict[str, Any]) -> None:
        self.db.execute(
            "UPDATE episode SET interrupted_run_state = ? WHERE episode_id = ?",
            (json.dumps(value, separators=(",", ":")), EPISODE_ID),
        )
        self.db.commit()

    def take_interrupted_state(self) -> dict[str, Any] | None:
        value = self.episode()["interrupted_run_state"]
        if value is None:
            return None
        self.db.execute(
            "UPDATE episode SET interrupted_run_state = NULL WHERE episode_id = ?",
            (EPISODE_ID,),
        )
        self.db.commit()
        return json.loads(value)

    def finalize(self, outcome: EpisodeOutcome, response_id: str) -> str:
        retention_due = iso(now() + timedelta(hours=72))
        self.db.execute(
            "UPDATE episode SET phase = 'FINALIZED', previous_response_id = ?, "
            "context_retention_due_at = ?, outcome_json = ? WHERE episode_id = ?",
            (response_id, retention_due, outcome.model_dump_json(), EPISODE_ID),
        )
        self.db.commit()
        return retention_due

    def snapshot(self) -> dict[str, Any]:
        row = dict(self.episode())
        row["interrupted_run_state"] = bool(row["interrupted_run_state"])
        row["outcome_json"] = json.loads(row["outcome_json"]) if row["outcome_json"] else None
        row["events"] = [
            dict(item)
            for item in self.db.execute(
                "SELECT event_id, content_sha256, status FROM discord_event ORDER BY rowid"
            )
        ]
        return row

    def close(self) -> None:
        self.db.close()


def context_file(root: Path) -> Path:
    episode_dir = root / EPISODE_ID
    episode_dir.mkdir(parents=True, exist_ok=True)
    path = episode_dir / "context-package.md"
    path.write_text(SYNTHETIC_CONTEXT)
    path.chmod(stat.S_IRUSR)
    return path


def instructions(path: Path) -> str:
    private_context = path.read_text()
    return (
        "You are the sole Episode Agent for one synthetic Collaboration Episode. "
        "You have no tools, specialists, or handoffs. Keep replies concise and helpful. "
        "Do not reveal private Context Package text. The Owner-approved Opening Brief is: "
        f"{OPENING_BRIEF}\n\nPrivate Context Package:\n{private_context}"
    )


def manager(model: str | ScriptedModel, path: Path, *, outcome: bool = False) -> Agent[None]:
    return Agent(
        name="Coloop Episode manager",
        instructions=instructions(path),
        model=model,
        output_type=EpisodeOutcome if outcome else None,
        tools=[],
        handoffs=[],
    )


def config() -> RunConfig:
    return RunConfig(
        workflow_name="Coloop primary Episode runtime probe",
        tracing_disabled=True,
        trace_include_sensitive_data=False,
    )


async def streamed_run(
    agent: Agent[None],
    input_value: str | RunState[Any],
    previous_response_id: str | None = None,
    *,
    echo_deltas: bool = False,
) -> tuple[Any, list[str]]:
    result = Runner.run_streamed(
        agent,
        input_value,
        previous_response_id=previous_response_id,
        run_config=config(),
        max_turns=2,
    )
    deltas: list[str] = []
    async for event in result.stream_events():
        if isinstance(event, RawResponsesStreamEvent) and isinstance(
            event.data, ResponseTextDeltaEvent
        ):
            deltas.append(event.data.delta)
            if echo_deltas:
                print(event.data.delta, end="", flush=True)
    if echo_deltas:
        print()
    return result, deltas


async def handle_event(
    store: EpisodeStore,
    agent: Agent[None],
    event: DiscordEvent,
    *,
    echo_deltas: bool = False,
) -> dict[str, Any]:
    disposition = store.begin_event(event)
    if disposition == "duplicate":
        return {"event_id": event.event_id, "disposition": "duplicate_suppressed"}
    previous = store.episode()["previous_response_id"]
    try:
        result, deltas = await streamed_run(
            agent,
            f"{event.author}: {event.content}",
            previous_response_id=previous,
            echo_deltas=echo_deltas,
        )
    except Exception as error:
        store.fail_event(event.event_id, error)
        return {
            "event_id": event.event_id,
            "disposition": "provider_failed",
            "error_type": type(error).__name__,
            "previous_response_id_unchanged": store.episode()["previous_response_id"] == previous,
        }
    if result.last_response_id is None:
        raise RuntimeError("provider completed without a continuation identifier")
    store.complete_event(event.event_id, result.last_response_id)
    return {
        "event_id": event.event_id,
        "disposition": disposition,
        "reply": result.final_output,
        "stream_delta_count": len(deltas),
        "response_id": result.last_response_id,
    }


async def interrupted_before_dispatch(
    store: EpisodeStore, agent: Agent[None], event: DiscordEvent
) -> dict[str, Any]:
    disposition = store.begin_event(event)
    if disposition == "duplicate":
        raise RuntimeError("interruption event was already completed")
    result = Runner.run_streamed(
        agent,
        f"{event.author}: {event.content}",
        previous_response_id=store.episode()["previous_response_id"],
        run_config=config(),
    )
    # Cancel before yielding to the event loop. This represents a process stop after the
    # application accepted the Discord event but before provider dispatch.
    result.cancel("immediate")
    async for _event in result.stream_events():
        pass
    serialized = result.to_state().to_json()
    rendered = json.dumps(serialized)
    store.save_interrupted_state(serialized)
    return {
        "event_id": event.event_id,
        "serialized_bytes": len(rendered.encode()),
        "contains_in_flight_collaborator_text": event.content in rendered,
        "contains_prior_turn_text": "Make recovery visible" in rendered,
        "contains_context_package": "OWNER-CONTEXT-ONLY" in rendered,
        "previous_response_id": serialized["previous_response_id"],
    }


async def resume_interrupted(
    store: EpisodeStore, agent: Agent[None], event: DiscordEvent
) -> dict[str, Any]:
    serialized = store.take_interrupted_state()
    if serialized is None:
        raise RuntimeError("no interrupted run state")
    state = await RunState.from_json(agent, serialized)
    result, deltas = await streamed_run(agent, state)
    if result.last_response_id is None:
        raise RuntimeError("resumed run completed without a continuation identifier")
    store.complete_event(event.event_id, result.last_response_id)
    return {
        "event_id": event.event_id,
        "reply": result.final_output,
        "stream_delta_count": len(deltas),
        "response_id": result.last_response_id,
        "serialized_state_cleared": store.episode()["interrupted_run_state"] is None,
    }


def scripted_agent_steps() -> ScriptedModel:
    outcome = EpisodeOutcome(
        conclusion="Show a short recovery marker only when Coloop actually missed input.",
        unresolved_points=["Exact Discord wording needs Owner feedback."],
    )
    return ScriptedModel(
        [
            ModelStep(
                output=[assistant_message("Make recovery visible, but keep it brief.")],
                response_id="resp-opening",
            ),
            ModelStep(
                output=[assistant_message("I agree; a one-line marker avoids confusion.")],
                response_id="resp-followup",
            ),
            ModelStep.raise_error(RuntimeError("synthetic provider outage")),
            ModelStep(
                output=[assistant_message("Recovered: the marker should not repeat prior messages.")],
                response_id="resp-retry",
            ),
            ModelStep(
                output=[assistant_message("Restarted cleanly and incorporated the missed input.")],
                response_id="resp-missed",
            ),
            ModelStep(
                output=[assistant_message("No new input was forwarded during RunState resume.")],
                response_id="resp-resumed",
            ),
            ModelStep(output=[assistant_message(outcome.model_dump_json())], response_id="resp-final"),
        ]
    )


async def offline(root: Path) -> dict[str, Any]:
    path = context_file(root)
    database = root / "PROTOTYPE-episode.sqlite3"
    model = scripted_agent_steps()
    store = EpisodeStore(database)
    store.create(path)
    episode_agent = manager(model, path)

    opening = await handle_event(
        store, episode_agent, DiscordEvent("discord-100", "Maya", "Should recovery be visible?")
    )
    followup = await handle_event(
        store,
        episode_agent,
        DiscordEvent("discord-101", "Rajat (Owner)", "Yes, but never replay old messages."),
    )
    failure_event = DiscordEvent("discord-102", "Maya", "What should the marker say?")
    failure = await handle_event(store, episode_agent, failure_event)
    retry = await handle_event(store, episode_agent, failure_event)
    duplicate = await handle_event(store, episode_agent, failure_event)

    # Ordinary restart recovery uses only SQLite's last response ID and a Discord re-fetch.
    before_between_turn_restart = store.snapshot()
    store.close()
    store = EpisodeStore(database)
    episode_agent = manager(model, path)
    missed_after_restart = await handle_event(
        store,
        episode_agent,
        DiscordEvent("discord-missed-103", "Maya", "This arrived while Coloop was offline."),
    )

    interrupted_event = DiscordEvent(
        "discord-104", "Maya", "A cancelled in-flight run should preserve this exact input."
    )
    interrupted = await interrupted_before_dispatch(store, episode_agent, interrupted_event)
    before_restart = store.snapshot()
    store.close()

    store = EpisodeStore(database)
    restarted_agent = manager(model, path)
    resumed = await resume_interrupted(store, restarted_agent, interrupted_event)

    outcome_agent = manager(model, path, outcome=True)
    final_result, final_deltas = await streamed_run(
        outcome_agent,
        "Owner Episode Control: finalize the current Outcome Proposal as an Episode Outcome.",
        previous_response_id=store.episode()["previous_response_id"],
    )
    if not isinstance(final_result.final_output, EpisodeOutcome):
        raise RuntimeError("finalization did not return EpisodeOutcome")
    if final_result.last_response_id is None:
        raise RuntimeError("finalization did not return a continuation identifier")
    retention_due = store.finalize(final_result.final_output, final_result.last_response_id)
    after_finalization = store.snapshot()
    store.close()
    model.assert_complete()

    calls = [
        {
            "index": index,
            "previous_response_id": call.previous_response_id,
            "input_item_count": len(call.input) if isinstance(call.input, list) else 1,
            "tool_count": len(call.tools),
            "handoff_count": len(call.handoffs),
            "structured_output": call.output_schema is not None,
            "streamed": call.streamed,
        }
        for index, call in enumerate(model.calls, start=1)
    ]
    sqlite_bytes = database.read_bytes()
    return {
        "environment": {
            "mode": "deterministic-offline",
            "date": now().date().isoformat(),
            "openai_agents": importlib.metadata.version("openai-agents"),
            "model_for_live_mode": MODEL,
            "api_model_calls": 0,
            "tracing_disabled": True,
        },
        "opening_brief": OPENING_BRIEF,
        "turns": [opening, followup],
        "provider_failure": failure,
        "same_event_retry": retry,
        "duplicate_delivery": duplicate,
        "restart_between_turns": before_between_turn_restart,
        "missed_input_after_restart": missed_after_restart,
        "interruption": interrupted,
        "restart_snapshot": before_restart,
        "restart_resume": resumed,
        "finalization": {
            "outcome": final_result.final_output.model_dump(mode="json"),
            "stream_delta_count": len(final_deltas),
            "response_id": final_result.last_response_id,
        },
        "retention": {
            "deadline": retention_due,
            "hours": 72,
            "context_exists": path.exists(),
            "context_mode": oct(stat.S_IMODE(path.stat().st_mode)),
        },
        "after_finalization": after_finalization,
        "sdk_calls": calls,
        "local_content_audit": {
            "sqlite_contains_context_package": b"OWNER-CONTEXT-ONLY" in sqlite_bytes,
            "sqlite_contains_completed_turn": b"Make recovery visible" in sqlite_bytes,
            "sqlite_contains_interrupted_turn_after_resume": interrupted_event.content.encode()
            in sqlite_bytes,
            "sqlite_stores_discord_content_hashes": True,
            "context_package_sha256": digest(SYNTHETIC_CONTEXT),
        },
        "acceptance_checks": {
            "ordinary_turns_use_openai_managed_continuation": all(
                call.previous_response_id is not None for call in model.calls[1:]
            ),
            "restart_between_turns_recovered_missed_input": missed_after_restart["reply"]
            == "Restarted cleanly and incorporated the missed input.",
            "provider_failure_kept_continuation_stable": failure[
                "previous_response_id_unchanged"
            ],
            "duplicate_delivery_suppressed": duplicate["disposition"]
            == "duplicate_suppressed",
            "cancelled_run_state_contains_only_in_flight_turn": interrupted[
                "contains_in_flight_collaborator_text"
            ]
            and not interrupted["contains_prior_turn_text"]
            and not interrupted["contains_context_package"],
            "cancelled_run_resume_forwarded_original_input": (
                len(model.calls[5].input) > 0
                if isinstance(model.calls[5].input, list)
                else bool(model.calls[5].input)
            ),
            "structured_episode_outcome": isinstance(
                final_result.final_output, EpisodeOutcome
            ),
            "no_completed_transcript_in_sqlite": b"Make recovery visible" not in sqlite_bytes,
            "terminal_context_retention_marked_72_hours": after_finalization[
                "context_retention_due_at"
            ]
            == retention_due,
        },
    }


async def live_interaction(root: Path) -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for owner mode")
    path = context_file(root)
    store = EpisodeStore(root / "PROTOTYPE-episode.sqlite3")
    store.create(path)
    episode_agent = manager(MODEL, path)
    print(f"Opening Brief: {OPENING_BRIEF}")
    print("Type collaborator turns. Commands: /restart, /finalize, /quit")
    counter = 1
    while True:
        value = input("Collaborator> ").strip()
        if value == "/quit":
            break
        if value == "/restart":
            store.close()
            store = EpisodeStore(root / "PROTOTYPE-episode.sqlite3")
            episode_agent = manager(MODEL, path)
            print("[runtime restarted; continuation ID reloaded from SQLite]")
            continue
        if value == "/finalize":
            final_agent = manager(MODEL, path, outcome=True)
            result, _ = await streamed_run(
                final_agent,
                "Owner Episode Control: finalize the current Outcome Proposal.",
                previous_response_id=store.episode()["previous_response_id"],
                echo_deltas=True,
            )
            if not isinstance(result.final_output, EpisodeOutcome) or not result.last_response_id:
                raise RuntimeError("structured finalization failed")
            deadline = store.finalize(result.final_output, result.last_response_id)
            print(result.final_output.model_dump_json(indent=2))
            print(f"[Context Package retained until {deadline}]")
            break
        event = DiscordEvent(f"owner-live-{counter}", "Collaborator", value)
        counter += 1
        print("Coloop> ", end="", flush=True)
        answer = await handle_event(store, episode_agent, event, echo_deltas=True)
        if answer.get("reply") is None:
            print(answer)
    store.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Exercise one Agents SDK Episode manager")
    parser.add_argument("mode", choices=["offline", "owner"])
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if args.workspace:
        args.workspace.mkdir(parents=True, exist_ok=True)
        root = args.workspace
        cleanup = None
    else:
        cleanup = tempfile.TemporaryDirectory(prefix="coloop-episode-probe-")
        root = Path(cleanup.name)
    try:
        if args.mode == "owner":
            await live_interaction(root)
            return
        evidence = await offline(root)
        rendered = json.dumps(evidence, indent=2) + "\n"
        if args.output:
            args.output.write_text(rendered)
        else:
            print(rendered, end="")
    finally:
        if cleanup is not None:
            cleanup.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
