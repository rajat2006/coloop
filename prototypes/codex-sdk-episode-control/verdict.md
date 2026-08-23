# Stable Codex SDK episode-control verdict

Exercise date: 2026-08-23

## Verdict

**Unsupported as the complete v0 Episode Agent control seam.** The stable
Python Codex SDK supports nearly all of the required local thread lifecycle,
but its high-level API does not expose Owner-visible approval requests. It
offers only automatic review or deny-all. Coloop therefore cannot let the Owner
inspect and decide a privileged action through the stable high-level SDK alone.

The SDK remains a strong candidate if Owner-visible approvals gain a documented
public callback or event API. Until then, meeting that requirement would mean
dropping below the stable high-level API to the lower-level App Server protocol,
or changing the product policy to deny all privileged actions. The latter is a
product decision, not something this exercise assumes.

The stable SDK also does not eliminate App Server as an implementation detail.
OpenAI documents that the Python SDK controls a local App Server over JSON-RPC
and ships a pinned Codex CLI runtime. The installed 0.147.0 client launches that
pinned runtime's `app-server` command over STDIO. Using the SDK avoids making
Coloop itself an App Server protocol client, but it is not a separate runtime.
[Official OpenAI Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)

## Capability results

| Required capability | Result | Evidence |
| --- | --- | --- |
| Multi-turn input | **Supported** | A second turn recalled the first turn's codeword and used the file created by that turn. |
| Streamed output | **Supported** | The first turn emitted 36 `item/agentMessage/delta` events plus lifecycle, item, diff, and usage events. |
| Resume after process restart | **Supported** | A new Python process resumed the persisted thread ID and returned the exact codeword. |
| Interruption | **Supported** | `TurnHandle.interrupt()` stopped a turn during `sleep 30`; terminal status was `interrupted` with no final response. |
| Owner-visible approvals | **Unsupported** | Static inspection found only `auto_review` and `deny_all`; `Codex(...)` exposes no approval callback. The high-level path cannot forward a request to the Owner and wait for their decision. |
| Isolated working directory | **Supported** | A thread rooted in a fresh temporary directory created its marker there, without needing the repository as its working directory. |
| Sandbox controls | **Supported** | `workspace_write` allowed the intended marker; a separate `read_only`/`deny_all` thread could not create its marker. |
| Schema-constrained Episode Outcome | **Supported** | `output_schema` produced parseable JSON with the required `accepted_answer`, `accepted_artifacts`, and `unresolved_points` fields and no extras. |
| ChatGPT subscription authentication | **Supported** | The SDK reported account type `chatgpt`, plan type `pro`, and completed all live turns without an API key. OpenAI documents browser and device-code ChatGPT login methods on the stable SDK. [Official OpenAI Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) |

## Exercise shape

The probe pins `openai-codex==0.147.0` and uses its bundled
`openai-codex-cli-bin==0.147.0`. It deliberately records no account email,
credential, token, or raw authentication file.

1. `surface` inspects only the documented top-level high-level API.
2. `start` creates a persistent thread with an isolated `cwd`, streams the
   first turn, continues with a schema-constrained second turn, and records a
   sanitized authentication summary.
3. `resume` runs in a new process, resumes the saved thread ID, and checks its
   conversational memory.
4. `read-only` tries and fails to create a file under a read-only sandbox.
5. `interrupt` interrupts an active long-running shell turn.

The runnable probe is in `probe.py`; sanitized observed output is in
`evidence.json`. OpenAI describes the stable Python SDK as a server-side local
Codex control surface with start, continue, resume, turn-level sandbox settings,
and a pinned runtime. [Official OpenAI Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)

## Consequence for the map

The later Codex adapter decision should not select the stable high-level SDK as
the sole v0 runtime while Owner-gated privileged actions remain a requirement.
The remaining sharp decision is whether v0:

- denies every action that would need approval and uses the stable SDK; or
- accepts a direct App Server integration for validation only, preserving
  Owner-visible approval events while keeping that dependency outside the
  production-support promise.
