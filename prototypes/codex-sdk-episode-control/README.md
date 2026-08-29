# Stable Codex SDK episode-control probe

This disposable probe exercises the stable Python `openai-codex` SDK against
the controls needed by a Coloop Episode Agent. It deliberately runs from an
isolated temporary working directory and never prints authentication tokens or
the ChatGPT account email.

The dependency is pinned to the tested stable release. Run each step as a
separate process so the resume check is meaningful:

```bash
PROBE_DIR="$(pwd)/prototypes/codex-sdk-episode-control"
STATE=/tmp/coloop-codex-sdk-state.json
WORKSPACE=/tmp/coloop-codex-sdk-workspace

uv run --project "$PROBE_DIR" python "$PROBE_DIR/probe.py" surface
uv run --project "$PROBE_DIR" python "$PROBE_DIR/probe.py" start \
  --state "$STATE" --workspace "$WORKSPACE"
uv run --project "$PROBE_DIR" python "$PROBE_DIR/probe.py" resume --state "$STATE"
uv run --project "$PROBE_DIR" python "$PROBE_DIR/probe.py" read-only \
  --workspace /tmp/coloop-codex-sdk-read-only
uv run --project "$PROBE_DIR" python "$PROBE_DIR/probe.py" interrupt \
  --workspace /tmp/coloop-codex-sdk-interrupt
```

The runtime reuses the current local Codex login. `start` reports only the
account kind and plan kind, which is enough to distinguish ChatGPT subscription
authentication from API-key authentication.
