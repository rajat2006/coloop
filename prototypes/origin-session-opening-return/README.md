# Origin Session opening and return prototype

This is a throwaway prototype for the question: does the hook-backed Codex
experience let an Owner approve the private Context Package and public Opening
Brief, open/control one Collaboration Episode, and receive its immutable Episode
Outcome automatically on the next turn of the same Origin Session?

The prototype has two complementary parts:

- `index.html` is the human-feedback surface. Open it directly and drive the
  happy path and awkward cases while watching every relevant state field.
- `probe.mjs` exercises the adapter logic against documented Codex hook payloads
  and the rollout transcript shape observed in a live Codex session. It uses a
  disposable JSON state file under a temporary directory and a synchronous
  stand-in for Discord provisioning.

Run the evidence probe:

```bash
node prototypes/origin-session-opening-return/probe.mjs \
  > prototypes/origin-session-opening-return/evidence.json
```

Open the walkthrough by double-clicking
`prototypes/origin-session-opening-return/index.html`.

## Supported seam exercised

- `PreToolUse` supplies `session_id`, `turn_id`, `transcript_path`, tool name,
  and tool input. The hook overwrites internal MCP arguments with the trusted
  Origin Session association before the Owner sees the approval.
- The parser includes only `user.text` Owner records and Codex `commentary` or
  `final_answer` output. It excludes injected instructions, environment and
  skill context, reasoning, tool traffic, files, images, and attachments. Any
  ambiguous visible-message shape fails closed.
- `UserPromptSubmit` asks the local store for an outcome pending for that exact
  `session_id` and returns it as `additionalContext`. An idle session receives
  no turn; another session receives nothing; a repeated hook call does not
  inject twice.

Official OpenAI documentation describes the hook fields and warns that the
transcript file format is not stable:
<https://learn.chatgpt.com/docs/hooks>.

## Client support finding

| Intended Codex client | Prototype status | Evidence |
| --- | --- | --- |
| CLI | Verified for `codex-cli 0.150.1` | The installed client reports hooks as stable/enabled; live CLI rollout metadata carries the expected session identity and transcript. |
| IDE extension | Unverified; fail closed | Official docs say CLI and IDE share configuration layers, but no installed IDE-origin session was available to validate the hook payload or transcript provenance. |
| Desktop app | Unverified; fail closed | Neither the installed environment nor the consulted official desktop documentation establishes hook execution and transcript behavior. |

This is intentionally narrower than saying “Codex supports hooks.” Exact
visible-text capture is a client/version compatibility promise because the
official hook contract explicitly does not stabilize the transcript schema.

## Deliberate limits

- The Discord URL and provisioning delay are local stand-ins. No Discord token
  or live server is required for this interaction decision.
- This does not install a hook or MCP server into the Owner's Codex config.
- `hook.mjs` is an executable command-hook boundary for `PreToolUse` and
  `UserPromptSubmit`; the probe feeds it equivalent payloads without changing
  the Owner's global Codex configuration.
- The parser is intentionally schema-pinned and fail-closed. A production
  adapter needs compatibility fixtures for each supported Codex client/version.
- The accepted Outcome remains in the prototype database so `get_episode`
  remains demonstrable after automatic return. Production retention and
  restart acknowledgement belong to the later storage/reconciliation decision.

This folder is evidence, not production code.
