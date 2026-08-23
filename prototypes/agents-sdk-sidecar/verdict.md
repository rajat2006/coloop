# Agents SDK sidecar verdict

Exercise date: 2026-08-23

## Verdict

**Inconclusive for v0 pending one live metered run.** The deterministic exercise
supports the architecture at the control-flow level: ordinary Discord turns
bypass the Agents SDK, both delegation patterns accept only a compact structured
envelope, Agents-as-tools returns control through its manager, a true handoff
changes `last_agent` to the specialist, approval pauses and resumes the same
run, and provider failure returns control to Codex.

The workspace had no `OPENAI_API_KEY`. Subscription authentication used by the
primary Codex process is not an Agents SDK Platform credential, so the exercise
made zero API calls and cannot honestly establish live token counts, cost,
trace export, model adherence, latency, or account-level failure behavior. The
runnable live path is preserved for that final check.

## Observed results

| Concern | Result |
| --- | --- |
| Hot path | Ordinary Discord input returned `codex_direct`; no SDK runner or API call was used. |
| Entry boundary | Pydantic rejected a collaborator-authored envelope before the SDK. Only `codex` or `owner` is accepted as `requested_by`. |
| Agents as tools | The manager remained `last_agent`; the bounded specialist was a nested tool and its result returned through the manager. |
| True handoff | The risk reviewer became `last_agent`, making the ownership switch concrete. |
| Approval | The agent-as-tool call produced an interruption, was explicitly approved, and resumed from the same run state. |
| Context | Only the synthetic envelope was supplied. No Discord history or repository content was transmitted. Exact fields, byte counts, hashes, and synthetic context are in `evidence.json`. |
| Trace policy | The exercise config fixes `trace_include_sensitive_data=False`. Offline trace export was disabled; live mode enables export with the same redaction policy. |
| Return semantics | Both paths require `SpecialistResult` and set `return_to="codex"`; manager ownership differs from specialist ownership as expected. |
| Failure handling | Invalid envelopes fail before the sidecar. A simulated provider outage failed closed, did not retry automatically, and returned a structured failure for Codex to handle. |
| Calls, tokens, cost | Offline SDK model-boundary requests were recorded, but API calls were zero. Token counts and cost remain unverified. |

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

## Remaining live check

Run `probe.py live` with a funded Platform key and the existing synthetic input.
The architecture becomes **sufficient** only if both patterns preserve the
observed ownership and approval behavior while recorded model calls, tokens,
estimated cost, trace visibility, and failure behavior stay within explicit v0
budgets. A failure of the hot-path bypass, structured return, approval pause, or
context boundary makes it **insufficient** rather than inconclusive.
