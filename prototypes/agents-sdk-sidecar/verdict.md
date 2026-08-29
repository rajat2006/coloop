# Agents SDK sidecar verdict

Exercise date: 2026-08-23

## Verdict

**Sufficient for v0 behind the required guardrails.** A live OpenAI Agents SDK
0.22.0 run with `gpt-5.6-luna` preserved the deterministic control seam:
ordinary Discord turns bypassed the sidecar, Agents-as-tools paused and resumed
after explicit approval while its manager retained control, a true handoff
changed `last_agent` to the specialist, and both routes returned a structured
`SpecialistResult` to Codex through the compact synthetic envelope.

All ten acceptance checks passed. The two successful routes made five API model
calls in total, used 1,919 input and 436 output tokens, cost an estimated
$0.000907, and completed in 8.22 seconds and 3.22 seconds. Trace export was
flushed with sensitive payloads disabled and every recorded ingest request was
accepted with HTTP 204. The dashboard UI was not visually inspected; visibility
is inferred from successful trace ingestion and the retained trace IDs.

## Observed results

| Concern | Result |
| --- | --- |
| Hot path | Ordinary Discord input returned `codex_direct`; no SDK runner or API call was used. |
| Entry boundary | Pydantic rejected a collaborator-authored envelope before the SDK. Only `codex` or `owner` is accepted as `requested_by`. |
| Agents as tools | The manager remained `last_agent`; the bounded specialist was a nested tool and its result returned through the manager. |
| True handoff | The risk reviewer became `last_agent`, making the ownership switch concrete. |
| Approval | The agent-as-tool call produced an interruption, was explicitly approved, and resumed from the same run state. |
| Context | Only the synthetic envelope was supplied. No Discord history or repository content was transmitted. Exact fields, byte counts, hashes, and synthetic context are in `evidence.json`. |
| Trace policy | `trace_include_sensitive_data=False`; four recorded trace-ingest requests returned HTTP 204 after an explicit flush. The dashboard UI was not visually inspected. |
| Return semantics | Both paths require `SpecialistResult` and set `return_to="codex"`; manager ownership differs from specialist ownership as expected. |
| Failure handling | A live request for an intentionally nonexistent model returned HTTP 400 in 0.52 seconds. The client allowed zero retries, the sidecar failed closed, and a structured failure returned to Codex. |
| Calls, tokens, cost | Five model calls; 1,919 input tokens; 436 output tokens; estimated total cost $0.000907 at published `gpt-5.6-luna` rates. |
| Latency | Agents-as-tools completed in 8.22 seconds including its approval pause and resume; true handoff completed in 3.22 seconds. |
| Model adherence | Both routes returned the required schema. One Agents-as-tools result was overly cautious and claimed synthetic context was missing, reinforcing that every sidecar result remains advisory. |

## Guardrails required for v0

1. Keep the sidecar behind a schema-valid `request_handoff`; never route raw
   collaborator text or ordinary Discord turns through it.
2. Accept only Codex or an explicit Owner action as the request origin, bind the
   request to one Collaboration Episode, allowlist specialists, and cap task and
   context sizes before any metered call.
3. Use Agents-as-tools by default so Codex retains ownership. Use true handoff
   only when the specialist should own the remainder of that bounded sidecar run;
   never confuse this with ownership of the Collaboration Episode.
4. Require an approval interruption before metered specialist invocation in the
   validation release. Persist and resume the same run state; fail closed on
   rejection, timeout, or lost state.
5. Give sidecar specialists no workspace, shell, network, Discord, or production
   tools by default. Add boundary-local tool guardrails before any capability is
   introduced.
6. Disable sensitive trace payloads, attach only synthetic or Owner-approved
   Context Package material, and retain trace IDs plus sanitized usage rather
   than raw prompts in product logs.
7. Enforce per-episode call, token, cost, retry, and time budgets in application
   code. Do not retry ambiguous failures automatically.
8. Treat every sidecar result as advisory structured input to Codex. Codex or the
   Owner decides whether to accept, retry, or continue without it.

## Validation boundary

The live exercise used limits of five model calls, 5,000 input tokens, 1,000
output tokens, $0.01 estimated cost, and 30 seconds per successful route. The
observed run stayed within every limit. These are validation limits, not the
production per-Episode budget policy required by guardrail 7.

The sufficiency verdict covers only the compact orchestration sidecar. It does
not authorize routing ordinary Collaboration Episode traffic through the
Agents SDK, granting specialists tools, replacing the Owner's approval, or
treating a handoff as a transfer of Singular Ownership.
