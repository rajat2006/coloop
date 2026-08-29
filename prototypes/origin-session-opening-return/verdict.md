# Verdict

**Status: accepted with bounded technical evidence.**

## Rejected first interaction

The first walkthrough exposed free-play controls, multiple scenario tabs, and
the complete technical state beside the primary flow. The Owner found it weird,
too complicated, and unclear what to do. That presentation is rejected.

The revised walkthrough presents one four-step happy path with one primary
action at a time. Technical state and retry/isolation checks remain available
only in optional details.

The Owner reviewed the revised walkthrough live and accepted it as clear enough
for v0.

## Selected interaction

- The Origin Session shows one editable Opening Brief and clearly names the
  private visible-text snapshot. One approval authorizes both and opens the
  Collaboration Episode.
- Successful synchronous setup returns the `ACTIVE` Episode and Discord link;
  v0 does not add a user-visible successful `OPENING` response based on the
  local path's low latency. Production Discord timing still needs ordinary
  implementation instrumentation rather than another product decision.
- A finalized Episode remains quiet while the Origin Session is dormant. On
  the Owner's next prompt, Codex presents the exact result and unresolved points
  before continuing with the new request.
- `get_episode` remains the status/outcome fallback and `cancel_episode` remains
  the separately approved terminal control. Neither needs another v0 status UI.
- The primary interaction is a guided happy path. Retry, isolation, credential,
  and terminal-race behavior stays out of the normal Owner flow.

## Supported client boundary

- Codex CLI 0.150.1 is the only opening client validated by the installed-client
  evidence and observed transcript provenance.
- IDE shares Codex configuration but lacks a validated hook/transcript fixture;
  desktop lacks both local and explicit documentary evidence. Both fail closed
  for v0 until separately proven compatible.
- Transcript parsing is version-pinned and fail-closed because OpenAI documents
  `transcript_path` while explicitly leaving its file format unstable.

## Provisional evidence

- The documented hook contract can bind `open_episode`, `get_episode`, and
  `cancel_episode` to a trusted Codex `session_id`; `PreToolUse.updatedInput`
  prevents model-authored identity from being authoritative.
- A live Codex rollout distinguishes Owner-authored `user.text` from injected
  AGENTS/environment/skill records and separates visible Codex output from
  reasoning and tool traffic. The observed schema supports exact visible-text
  capture, but OpenAI explicitly says the transcript format is unstable, so the
  adapter must pin supported versions and fail closed.
- `UserPromptSubmit.additionalContext` supports automatic deferred return on the
  next prompt in the same Origin Session. It cannot create an unsolicited turn
  in a dormant conversation.
- The local state probe passes opening, duplicate-open, credential block,
  origin isolation, immutable finalization, at-most-once next-turn injection,
  retrieval fallback, and late-cancellation checks.
- Only Codex CLI 0.150.1 is validated as a v0 opening client by this prototype.
  IDE shares configuration but lacks payload/transcript evidence; desktop lacks
  both local and explicit documentary evidence. Both must fail closed until
  separate compatibility fixtures pass.

## Still requiring live Owner judgment

- Whether previewing one editable Opening Brief and authorizing it together
  with the private snapshot feels sufficiently explicit without added ceremony.
- Whether the next-turn interruption—present the exact Episode Outcome first,
  then continue the new request—is understandable and useful.
- Whether `get_episode` and `cancel_episode` expose enough control without a
  separate status surface.

No behavior is accepted or rejected until the Owner drives `index.html` and
responds to those questions.
