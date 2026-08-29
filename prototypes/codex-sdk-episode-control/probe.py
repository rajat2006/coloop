from __future__ import annotations

import argparse
import importlib.metadata
import inspect
import json
import threading
from collections import Counter
from pathlib import Path
from typing import Any

from openai_codex import ApprovalMode, Codex, Sandbox


OUTCOME_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "accepted_answer": {"type": "string"},
        "accepted_artifacts": {
            "type": "array",
            "items": {"type": "string"},
        },
        "unresolved_points": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": ["accepted_answer", "accepted_artifacts", "unresolved_points"],
    "additionalProperties": False,
}

CODEWORD = "ORBIT-CEDAR-731"


def emit(payload: dict[str, Any], output: Path | None) -> None:
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")


def account_summary(codex: Codex) -> dict[str, Any]:
    raw = codex.account().model_dump(mode="json")
    account = raw.get("account") or {}
    return {
        "requires_openai_auth": raw.get("requires_openai_auth"),
        "type": account.get("type"),
        "plan_type": account.get("plan_type"),
    }


def start(args: argparse.Namespace) -> None:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    marker = workspace / "episode-marker.txt"
    marker.unlink(missing_ok=True)

    with Codex() as codex:
        thread = codex.thread_start(
            cwd=str(workspace),
            sandbox=Sandbox.workspace_write,
            approval_mode=ApprovalMode.auto_review,
        )
        turn = thread.turn(
            (
                f"Remember the codeword {CODEWORD}. Create episode-marker.txt in the "
                f"current working directory containing exactly {CODEWORD}, then reply "
                "briefly. Do not inspect any parent directory."
            )
        )
        event_counts: Counter[str] = Counter()
        streamed_text = ""
        completion_status = None
        for event in turn.stream():
            event_counts[event.method] += 1
            delta = getattr(event.payload, "delta", None)
            if event.method == "item/agentMessage/delta" and isinstance(delta, str):
                streamed_text += delta
            if event.method == "turn/completed":
                completion_status = event.payload.turn.status.value

        outcome = thread.run(
            (
                "Return an Episode Outcome. accepted_answer must be the codeword you "
                "remembered. accepted_artifacts must contain the exact current contents "
                "of episode-marker.txt. unresolved_points must be empty. Return only the "
                "schema-constrained result."
            ),
            output_schema=OUTCOME_SCHEMA,
        )

        parsed_outcome = json.loads(outcome.final_response or "")
        state = {
            "thread_id": thread.id,
            "workspace": str(workspace),
            "codeword": CODEWORD,
        }
        args.state.parent.mkdir(parents=True, exist_ok=True)
        args.state.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

        emit(
            {
                "probe": "start",
                "sdk_version": importlib.metadata.version("openai-codex"),
                "authentication": account_summary(codex),
                "thread_id": thread.id,
                "first_turn_status": completion_status,
                "stream_event_counts": dict(sorted(event_counts.items())),
                "streamed_agent_text": streamed_text,
                "marker_exists": marker.exists(),
                "marker_contents": marker.read_text(encoding="utf-8") if marker.exists() else None,
                "structured_turn_status": outcome.status.value,
                "structured_outcome": parsed_outcome,
            },
            args.output,
        )


def resume(args: argparse.Namespace) -> None:
    state = json.loads(args.state.read_text(encoding="utf-8"))
    workspace = Path(state["workspace"])
    with Codex() as codex:
        thread = codex.thread_resume(
            state["thread_id"],
            cwd=str(workspace),
            sandbox=Sandbox.read_only,
            approval_mode=ApprovalMode.deny_all,
        )
        result = thread.run(
            "What codeword did I ask you to remember? Reply with the codeword only."
        )
        response = (result.final_response or "").strip()
        emit(
            {
                "probe": "resume",
                "sdk_version": importlib.metadata.version("openai-codex"),
                "thread_id": thread.id,
                "status": result.status.value,
                "response": response,
                "matched": response == state["codeword"],
            },
            args.output,
        )


def read_only(args: argparse.Namespace) -> None:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    forbidden = workspace / "forbidden-marker.txt"
    forbidden.unlink(missing_ok=True)
    with Codex() as codex:
        thread = codex.thread_start(
            cwd=str(workspace),
            sandbox=Sandbox.read_only,
            approval_mode=ApprovalMode.deny_all,
        )
        result = thread.run(
            "Try to create forbidden-marker.txt in the current working directory, then "
            "state whether the write succeeded. Do not inspect any parent directory."
        )
        emit(
            {
                "probe": "read-only",
                "status": result.status.value,
                "response": result.final_response,
                "forbidden_marker_exists": forbidden.exists(),
            },
            args.output,
        )


def interrupt(args: argparse.Namespace) -> None:
    workspace = args.workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    with Codex() as codex:
        thread = codex.thread_start(
            cwd=str(workspace),
            sandbox=Sandbox.workspace_write,
            approval_mode=ApprovalMode.auto_review,
        )
        turn = thread.turn(
            "Use the shell to run `sleep 30`, wait for it to finish, then reply DONE."
        )
        interruption: dict[str, Any] = {"requested": False, "error": None}

        def request_interrupt() -> None:
            try:
                turn.interrupt()
                interruption["requested"] = True
            except Exception as error:  # pragma: no cover - evidence path
                interruption["error"] = f"{type(error).__name__}: {error}"

        timer = threading.Timer(2.0, request_interrupt)
        timer.start()
        try:
            result = turn.run()
        finally:
            timer.cancel()
            timer.join()
        emit(
            {
                "probe": "interrupt",
                "thread_id": thread.id,
                "turn_id": turn.id,
                "interrupt_requested": interruption["requested"],
                "interrupt_error": interruption["error"],
                "status": result.status.value,
                "final_response": result.final_response,
            },
            args.output,
        )


def inspect_surface(args: argparse.Namespace) -> None:
    emit(
        {
            "probe": "surface",
            "sdk_version": importlib.metadata.version("openai-codex"),
            "approval_modes": [mode.value for mode in ApprovalMode],
            "codex_constructor": str(inspect.signature(Codex)),
            "thread_start": str(inspect.signature(Codex.thread_start)),
            "notes": [
                "The high-level stable Codex constructor exposes no approval callback.",
                "The only high-level approval modes are automatic review and deny all.",
            ],
        },
        args.output,
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Probe stable Codex SDK episode controls")
    subparsers = root.add_subparsers(dest="command", required=True)

    def common(command: str, handler: Any, *, state: bool = False) -> None:
        sub = subparsers.add_parser(command)
        sub.add_argument("--output", type=Path)
        if state:
            sub.add_argument("--state", type=Path, required=True)
        sub.set_defaults(handler=handler)

    common("surface", inspect_surface)
    common("start", start, state=True)
    subparsers.choices["start"].add_argument("--workspace", type=Path, required=True)
    common("resume", resume, state=True)
    common("read-only", read_only)
    subparsers.choices["read-only"].add_argument("--workspace", type=Path, required=True)
    common("interrupt", interrupt)
    subparsers.choices["interrupt"].add_argument("--workspace", type=Path, required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
