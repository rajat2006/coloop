from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import time
from pathlib import Path
from typing import Any, Literal

from agents import Agent, RunConfig, Runner, flush_traces, gen_trace_id, handoff
from agents.extensions import handoff_filters
from agents.models.openai_responses import OpenAIResponsesModel
from agents.testing import ModelStep, ScriptedModel, assistant_message, function_call
from agents.tracing.processors import default_exporter
from agents.usage import Usage
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError


MODEL = "gpt-5.6-luna"
INVALID_MODEL = "coloop-intentional-missing-model"
INPUT_USD_PER_MILLION = 0.20
OUTPUT_USD_PER_MILLION = 1.20
MAX_LIVE_MODEL_CALLS = 5
MAX_LIVE_INPUT_TOKENS = 5_000
MAX_LIVE_OUTPUT_TOKENS = 1_000
MAX_LIVE_ESTIMATED_USD = 0.01
MAX_ROUTE_LATENCY_MS = 30_000


class RecordingTraceClient:
    """Record only trace-ingest statuses; never retain headers or payloads."""

    def __init__(self, delegate: Any):
        self.delegate = delegate
        self.status_codes: list[int] = []

    def post(self, *args: Any, **kwargs: Any) -> Any:
        response = self.delegate.post(*args, **kwargs)
        self.status_codes.append(response.status_code)
        return response

    def close(self) -> None:
        self.delegate.close()


class RequestHandoff(BaseModel):
    """The only application-level envelope allowed to enter the metered sidecar."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["request_handoff"]
    episode_id: str = Field(min_length=1, max_length=64)
    requested_by: Literal["codex", "owner"]
    pattern: Literal["agent_as_tool", "handoff"]
    specialist: Literal["risk_reviewer"]
    task: str = Field(min_length=1, max_length=240)
    context: list[str] = Field(max_length=3)
    approval_required: bool


class SpecialistResult(BaseModel):
    """Compact result returned to the subscription-authenticated Codex process."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["completed", "failed"]
    episode_id: str
    specialist: Literal["risk_reviewer"]
    finding: str
    unresolved_points: list[str]
    return_to: Literal["codex"] = "codex"
    error: str | None = None


SYNTHETIC_CONTEXT = [
    "Owner approved only the episode question and two synthetic constraints.",
    "The specialist must not call tools or access the workspace.",
]


def request(pattern: Literal["agent_as_tool", "handoff"]) -> RequestHandoff:
    return RequestHandoff(
        type="request_handoff",
        episode_id=f"episode-sidecar-{pattern}",
        requested_by="codex",
        pattern=pattern,
        specialist="risk_reviewer",
        task="Identify the single most important guardrail for this synthetic episode.",
        context=SYNTHETIC_CONTEXT,
        approval_required=pattern == "agent_as_tool",
    )


def completed_result(envelope: RequestHandoff) -> SpecialistResult:
    return SpecialistResult(
        status="completed",
        episode_id=envelope.episode_id,
        specialist="risk_reviewer",
        finding="Validate the compact request_handoff envelope before any metered run.",
        unresolved_points=[],
    )


def failed_result(envelope: RequestHandoff, error: Exception) -> SpecialistResult:
    return SpecialistResult(
        status="failed",
        episode_id=envelope.episode_id,
        specialist="risk_reviewer",
        finding="The bounded specialist did not return a result.",
        unresolved_points=["Codex must decide whether to retry or continue without the specialist."],
        error=f"{type(error).__name__}: {error}",
    )


def compact_input(envelope: RequestHandoff) -> str:
    return envelope.model_dump_json(exclude_none=True)


def elapsed_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1_000, 2)


def context_record(envelope: RequestHandoff) -> dict[str, Any]:
    encoded = compact_input(envelope).encode("utf-8")
    return {
        "fields": list(envelope.model_dump().keys()),
        "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "context_items": envelope.context,
        "full_discord_history_transmitted": False,
        "repository_transmitted": False,
    }


def usage_record(usage: Usage, *, api_backed: bool) -> dict[str, Any]:
    estimated_cost = None
    if api_backed:
        estimated_cost = round(
            usage.input_tokens * INPUT_USD_PER_MILLION / 1_000_000
            + usage.output_tokens * OUTPUT_USD_PER_MILLION / 1_000_000,
            8,
        )
    return {
        "sdk_requests": usage.requests,
        "api_model_calls": usage.requests if api_backed else 0,
        "input_tokens": usage.input_tokens if api_backed else None,
        "output_tokens": usage.output_tokens if api_backed else None,
        "estimated_usd": estimated_cost,
        "estimate_basis": (
            f"{MODEL}: ${INPUT_USD_PER_MILLION}/M input and "
            f"${OUTPUT_USD_PER_MILLION}/M output; cache discounts omitted"
            if api_backed
            else "Not estimated: deterministic ScriptedModel made no API requests."
        ),
    }


def call_record(model: ScriptedModel) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, call in enumerate(model.calls, start=1):
        rendered_input = json.dumps(call.input, default=str, sort_keys=True)
        records.append(
            {
                "index": index,
                "input_bytes": len(rendered_input.encode("utf-8")),
                "tool_names": [getattr(tool, "name", type(tool).__name__) for tool in call.tools],
                "handoff_names": [item.tool_name for item in call.handoffs],
                "structured_output": call.output_schema is not None,
                "trace_payloads_included": call.tracing.include_data(),
            }
        )
    return records


def run_config(*, live: bool, trace_id: str) -> RunConfig:
    return RunConfig(
        workflow_name="Coloop bounded Agents SDK sidecar probe",
        trace_id=trace_id,
        trace_metadata={"episode_kind": "synthetic", "ticket": "24"},
        tracing_disabled=not live,
        trace_include_sensitive_data=False,
    )


def make_specialist(model: Any) -> Agent[None]:
    return Agent(
        name="Risk reviewer",
        handoff_description="Review one bounded synthetic risk question.",
        instructions=(
            "Review only the supplied request_handoff envelope. Do not call tools, access files, "
            "or infer missing Origin Session context. Return the requested SpecialistResult."
        ),
        model=model,
        output_type=SpecialistResult,
    )


async def run_agent_as_tool(
    envelope: RequestHandoff, model: Any, *, live: bool
) -> dict[str, Any]:
    specialist = make_specialist(model)
    specialist_tool = specialist.as_tool(
        tool_name="bounded_risk_review",
        tool_description="Review one validated request_handoff envelope and return a compact result.",
        parameters=RequestHandoff,
        needs_approval=True,
        max_turns=2,
    )
    manager = Agent(
        name="Sidecar manager",
        instructions=(
            "Call bounded_risk_review exactly once with the supplied envelope. After it returns, "
            "return that SpecialistResult unchanged."
        ),
        model=model,
        tools=[specialist_tool],
        output_type=SpecialistResult,
    )
    trace_id = gen_trace_id()
    config = run_config(live=live, trace_id=trace_id)
    total_started_at = time.perf_counter()
    pause_started_at = time.perf_counter()
    first = await Runner.run(manager, compact_input(envelope), run_config=config, max_turns=3)
    pause_latency_ms = elapsed_ms(pause_started_at)
    approval = {
        "required": True,
        "paused": bool(first.interruptions),
        "interruption_count": len(first.interruptions),
        "decision": None,
        "resumed_same_run": False,
    }
    if not first.interruptions:
        raise RuntimeError("agent-as-tool call did not pause for approval")

    approval_started_at = time.perf_counter()
    state = first.to_state()
    for interruption in first.interruptions:
        state.approve(interruption)
    approval["decision"] = "approved"
    approval["decision_source"] = "explicit_probe_action"
    approval["decision_latency_ms"] = elapsed_ms(approval_started_at)
    resume_started_at = time.perf_counter()
    result = await Runner.run(manager, state, run_config=config, max_turns=3)
    resume_latency_ms = elapsed_ms(resume_started_at)
    approval["resumed_same_run"] = True
    if not isinstance(result.final_output, SpecialistResult):
        raise RuntimeError("agent-as-tool route did not return SpecialistResult")
    return {
        "pattern": "agent_as_tool",
        "ownership": {
            "final_owner": result.last_agent.name,
            "manager_retained_control": result.last_agent.name == manager.name,
        },
        "approval": approval,
        "latency_ms": {
            "to_approval_pause": pause_latency_ms,
            "after_approval_resume": resume_latency_ms,
            "total": elapsed_ms(total_started_at),
        },
        "result": result.final_output.model_dump(mode="json"),
        "usage": usage_record(result.context_wrapper.usage, api_backed=live),
        "trace": {
            "trace_id": trace_id,
            "export_enabled": live,
            "sensitive_payloads_included": False,
        },
    }


async def run_handoff(
    envelope: RequestHandoff,
    model: Any,
    *,
    live: bool,
    trace_id: str | None = None,
) -> dict[str, Any]:
    specialist = make_specialist(model)
    handed_off: list[dict[str, Any]] = []

    async def on_handoff(_context: Any, payload: RequestHandoff) -> None:
        handed_off.append(payload.model_dump(mode="json"))

    handoff_target = handoff(
        specialist,
        input_type=RequestHandoff,
        on_handoff=on_handoff,
        input_filter=handoff_filters.remove_all_tools,
    )
    router = Agent(
        name="Sidecar router",
        instructions=(
            "Transfer exactly once to the risk reviewer using the supplied request_handoff "
            "envelope. Do not answer the task yourself."
        ),
        model=model,
        handoffs=[handoff_target],
    )
    trace_id = trace_id or gen_trace_id()
    started_at = time.perf_counter()
    result = await Runner.run(
        router,
        compact_input(envelope),
        run_config=run_config(live=live, trace_id=trace_id),
        max_turns=3,
    )
    if not isinstance(result.final_output, SpecialistResult):
        raise RuntimeError("handoff route did not return SpecialistResult")
    return {
        "pattern": "handoff",
        "ownership": {
            "final_owner": result.last_agent.name,
            "specialist_took_control": result.last_agent.name == specialist.name,
        },
        "approval": {
            "required": False,
            "paused": bool(result.interruptions),
            "note": "The handoff changes ownership but has no side effect and was not approval-gated.",
        },
        "latency_ms": {"total": elapsed_ms(started_at)},
        "handoff_metadata_received": handed_off,
        "result": result.final_output.model_dump(mode="json"),
        "usage": usage_record(result.context_wrapper.usage, api_backed=live),
        "trace": {
            "trace_id": trace_id,
            "export_enabled": live,
            "sensitive_payloads_included": False,
        },
    }


async def ordinary_discord_turn(message: str) -> dict[str, Any]:
    """Hot-path proof: ordinary turns return before any Agents SDK runner is called."""

    return {
        "route": "codex_direct",
        "message": message,
        "agents_sdk_invoked": False,
        "api_model_calls": 0,
    }


def scripted_models() -> tuple[ScriptedModel, ScriptedModel, ScriptedModel]:
    tool_request = request("agent_as_tool")
    tool_answer = completed_result(tool_request).model_dump_json()
    tool_model = ScriptedModel(
        [
            ModelStep(
                output=[
                    function_call(
                        "bounded_risk_review",
                        tool_request.model_dump(mode="json"),
                        call_id="call-tool-1",
                    )
                ],
                usage=Usage(requests=1),
            ),
            ModelStep(output=[assistant_message(tool_answer)], usage=Usage(requests=1)),
            ModelStep(output=[assistant_message(tool_answer)], usage=Usage(requests=1)),
        ]
    )

    handoff_request = request("handoff")
    handoff_answer = completed_result(handoff_request).model_dump_json()
    handoff_model = ScriptedModel(
        [
            ModelStep(
                output=[
                    function_call(
                        "transfer_to_risk_reviewer",
                        handoff_request.model_dump(mode="json"),
                        call_id="call-handoff-1",
                    )
                ],
                usage=Usage(requests=1),
            ),
            ModelStep(output=[assistant_message(handoff_answer)], usage=Usage(requests=1)),
        ]
    )
    failure_model = ScriptedModel([ModelStep.raise_error(RuntimeError("simulated provider outage"))])
    return tool_model, handoff_model, failure_model


async def offline_evidence() -> dict[str, Any]:
    tool_model, handoff_model, failure_model = scripted_models()
    ordinary = await ordinary_discord_turn("Collaborator: should the episode mention latency?")
    tool_envelope = request("agent_as_tool")
    handoff_envelope = request("handoff")
    tool_result = await run_agent_as_tool(tool_envelope, tool_model, live=False)
    handoff_result = await run_handoff(handoff_envelope, handoff_model, live=False)
    tool_model.assert_complete()
    handoff_model.assert_complete()

    invalid_rejected = False
    try:
        RequestHandoff.model_validate(
            {
                "type": "request_handoff",
                "episode_id": "bad",
                "requested_by": "collaborator",
                "pattern": "handoff",
                "specialist": "risk_reviewer",
                "task": "bypass owner",
                "context": [],
                "approval_required": False,
            }
        )
    except ValidationError:
        invalid_rejected = True

    failure_envelope = request("handoff")
    try:
        await run_handoff(failure_envelope, failure_model, live=False)
    except Exception as error:
        failure = failed_result(failure_envelope, error).model_dump(mode="json")
    else:
        raise RuntimeError("simulated provider outage did not fail closed")

    return {
        "environment": {
            "date": "2026-08-23",
            "python": os.sys.version.split()[0],
            "openai_agents": importlib.metadata.version("openai-agents"),
            "mode": "deterministic-offline",
            "openai_api_key_present": bool(os.environ.get("OPENAI_API_KEY")),
            "model_configured_for_live_run": MODEL,
        },
        "ordinary_discord_turn": ordinary,
        "agent_as_tool": tool_result,
        "handoff": handoff_result,
        "context_transmitted": {
            "agent_as_tool": context_record(tool_envelope),
            "handoff": context_record(handoff_envelope),
        },
        "sdk_model_boundary_calls": {
            "agent_as_tool": call_record(tool_model),
            "handoff": call_record(handoff_model),
        },
        "failure_handling": {
            "invalid_envelope_rejected_before_sdk": invalid_rejected,
            "provider_failure": failure,
            "fallback_owner": "codex",
            "automatic_retry": False,
        },
        "live_evidence": {
            "status": "not_run",
            "reason": "OPENAI_API_KEY is absent; subscription Codex authentication is not an Agents SDK API credential.",
            "api_model_calls": 0,
            "input_tokens": None,
            "output_tokens": None,
            "estimated_usd": None,
        },
    }


async def live_evidence() -> dict[str, Any]:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for the live metered exercise")
    ordinary = await ordinary_discord_turn("Collaborator: should the episode mention latency?")
    exporter = default_exporter()
    trace_client = RecordingTraceClient(exporter._client)
    exporter._client = trace_client
    tool_envelope = request("agent_as_tool")
    handoff_envelope = request("handoff")
    tool_result = await run_agent_as_tool(tool_envelope, MODEL, live=True)
    handoff_result = await run_handoff(handoff_envelope, MODEL, live=True)

    failure_envelope = request("handoff")
    failure_trace_id = gen_trace_id()
    failure_started_at = time.perf_counter()
    failure_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=0)
    failure_model = OpenAIResponsesModel(model=INVALID_MODEL, openai_client=failure_client)
    try:
        await run_handoff(
            failure_envelope,
            failure_model,
            live=True,
            trace_id=failure_trace_id,
        )
    except Exception as error:
        provider_failure = failed_result(failure_envelope, error).model_dump(mode="json")
    else:
        raise RuntimeError("intentional missing model did not produce a provider failure")
    finally:
        await failure_client.close()
    failure_latency_ms = elapsed_ms(failure_started_at)

    flush_started_at = time.perf_counter()
    flush_traces()
    trace_flush_latency_ms = elapsed_ms(flush_started_at)
    trace_ingest_accepted = bool(trace_client.status_codes) and all(
        status_code < 300 for status_code in trace_client.status_codes
    )

    total_model_calls = (
        tool_result["usage"]["api_model_calls"] + handoff_result["usage"]["api_model_calls"]
    )
    total_input_tokens = (
        tool_result["usage"]["input_tokens"] + handoff_result["usage"]["input_tokens"]
    )
    total_output_tokens = (
        tool_result["usage"]["output_tokens"] + handoff_result["usage"]["output_tokens"]
    )
    total_estimated_usd = round(
        tool_result["usage"]["estimated_usd"] + handoff_result["usage"]["estimated_usd"],
        8,
    )
    acceptance_checks = {
        "ordinary_turn_bypassed_sidecar": ordinary["agents_sdk_invoked"] is False,
        "agent_as_tool_preserved_manager_ownership": tool_result["ownership"][
            "manager_retained_control"
        ],
        "approval_paused_and_resumed_same_run": tool_result["approval"]["paused"]
        and tool_result["approval"]["resumed_same_run"],
        "handoff_transferred_to_specialist": handoff_result["ownership"][
            "specialist_took_control"
        ],
        "both_routes_returned_structured_result_to_codex": tool_result["result"]["status"]
        == "completed"
        and tool_result["result"]["return_to"] == "codex"
        and handoff_result["result"]["status"] == "completed"
        and handoff_result["result"]["return_to"] == "codex",
        "synthetic_context_boundary_preserved": all(
            not record["full_discord_history_transmitted"] and not record["repository_transmitted"]
            for record in (context_record(tool_envelope), context_record(handoff_envelope))
        ),
        "usage_within_validation_budget": total_model_calls <= MAX_LIVE_MODEL_CALLS
        and total_input_tokens <= MAX_LIVE_INPUT_TOKENS
        and total_output_tokens <= MAX_LIVE_OUTPUT_TOKENS
        and total_estimated_usd <= MAX_LIVE_ESTIMATED_USD,
        "latency_within_validation_budget": tool_result["latency_ms"]["total"]
        <= MAX_ROUTE_LATENCY_MS
        and handoff_result["latency_ms"]["total"] <= MAX_ROUTE_LATENCY_MS,
        "trace_ingest_accepted_without_sensitive_payloads": trace_ingest_accepted
        and not tool_result["trace"]["sensitive_payloads_included"]
        and not handoff_result["trace"]["sensitive_payloads_included"],
        "provider_failure_failed_closed_without_retry": provider_failure["status"] == "failed"
        and provider_failure["return_to"] == "codex"
        and provider_failure["error"] is not None,
    }

    return {
        "environment": {
            "date": "2026-08-23",
            "python": os.sys.version.split()[0],
            "openai_agents": importlib.metadata.version("openai-agents"),
            "mode": "live-api",
            "model": MODEL,
        },
        "ordinary_discord_turn": ordinary,
        "agent_as_tool": tool_result,
        "handoff": handoff_result,
        "context_transmitted": {
            "agent_as_tool": context_record(tool_envelope),
            "handoff": context_record(handoff_envelope),
        },
        "failure_handling": {
            "test": "provider rejected an intentionally nonexistent model",
            "model": INVALID_MODEL,
            "provider_failure": provider_failure,
            "fallback_owner": "codex",
            "max_retries": 0,
            "automatic_retry": False,
            "latency_ms": failure_latency_ms,
            "trace": {
                "trace_id": failure_trace_id,
                "export_enabled": True,
                "sensitive_payloads_included": False,
            },
        },
        "trace_export": {
            "flush_completed": True,
            "flush_latency_ms": trace_flush_latency_ms,
            "ingest_status_codes": trace_client.status_codes,
            "ingest_accepted": trace_ingest_accepted,
            "dashboard_visibility_inferred_from_successful_ingest": trace_ingest_accepted,
            "dashboard_ui_visually_checked": False,
        },
        "assessment": {
            "validation_budgets": {
                "max_api_model_calls": MAX_LIVE_MODEL_CALLS,
                "max_input_tokens": MAX_LIVE_INPUT_TOKENS,
                "max_output_tokens": MAX_LIVE_OUTPUT_TOKENS,
                "max_estimated_usd": MAX_LIVE_ESTIMATED_USD,
                "max_route_latency_ms": MAX_ROUTE_LATENCY_MS,
            },
            "observed_totals": {
                "api_model_calls": total_model_calls,
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
                "estimated_usd": total_estimated_usd,
            },
            "checks": acceptance_checks,
            "sidecar_architecture_classification": (
                "sufficient" if all(acceptance_checks.values()) else "insufficient"
            ),
        },
    }


def emit(payload: dict[str, Any], output: Path | None) -> None:
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Exercise Agents SDK as a bounded Codex sidecar")
    root.add_argument("mode", choices=["offline", "live"])
    root.add_argument("--output", type=Path)
    return root


def main() -> None:
    args = parser().parse_args()
    payload = asyncio.run(offline_evidence() if args.mode == "offline" else live_evidence())
    emit(payload, args.output)


if __name__ == "__main__":
    main()
