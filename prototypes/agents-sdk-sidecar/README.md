# Agents SDK sidecar probe

This disposable exercise tests whether the API-metered OpenAI Agents SDK can
stay behind a compact `request_handoff` boundary while subscription-authenticated
Codex remains the primary Episode Agent. It models Discord ingress locally; it
does not connect to Discord or call Codex.

Ordinary collaborator messages return through `codex_direct` before an Agents
SDK runner is created. Only a schema-valid envelope emitted by Codex or an
explicit Owner action enters the sidecar. The exercise compares:

- **Agents as tools:** a sidecar manager retains ownership, the bounded
  specialist call pauses for explicit approval, and the structured result
  returns through the manager to Codex.
- **Handoff:** a router transfers control to the bounded specialist for the rest
  of the run; `last_agent` identifies the specialist as the new owner.

Run the deterministic exercise, which makes no API request:

```bash
PROBE_DIR="$(pwd)/prototypes/agents-sdk-sidecar"
uv run --project "$PROBE_DIR" python "$PROBE_DIR/probe.py" offline \
  --output "$PROBE_DIR/evidence.json"
```

Run the same boundary against the OpenAI API only from an environment that has
a separately funded Platform key:

```bash
PROBE_DIR="$(pwd)/prototypes/agents-sdk-sidecar"
OPENAI_API_KEY="..." uv run --project "$PROBE_DIR" \
  python "$PROBE_DIR/probe.py" live --output /tmp/agents-sidecar-live.json
```

The live mode uses `gpt-5.6-luna`, disables sensitive trace payloads, exports
the trace, records aggregated SDK usage, and estimates standard token cost.
Never commit live evidence containing real Context Package material. Use only
the synthetic envelope already defined in `probe.py`.

Official OpenAI documentation distinguishes the two ownership patterns and
documents resumable approval interruptions, result state, traces, and usage:

- [Agents SDK overview](https://developers.openai.com/api/docs/guides/agents)
- [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Results and state](https://developers.openai.com/api/docs/guides/agents/results)
- [Integrations and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability)
- [Current model catalog and prices](https://developers.openai.com/api/docs/models)
