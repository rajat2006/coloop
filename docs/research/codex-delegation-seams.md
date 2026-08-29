# Supported Codex delegation and return seams

Research date: 2026-08-23

## Question

Which officially supported Codex extensibility seams can open a bounded
delegate from an active Origin Session, supply an owner-approved Context
Package, run agent work reachable from Discord, and return a structured Episode
Outcome? How do Codex subscription entitlements differ from OpenAI API or SDK
billing, and what constraints follow for authentication, continuity, tools,
structured output, and deployment?

## Direct answer

The v0 **validation release** can use only documented Codex surfaces and does
**not** require the generic OpenAI API. The complete rich-client path is
feasible, but not yet a production-ready commitment because OpenAI currently
marks the `app-server` command experimental and unsupported for production:

1. Expose `open_episode` and `get_episode_outcome` as Coloop MCP tools to the
   Origin Session. Local Codex clients support both local STDIO MCP servers and
   remote Streamable HTTP MCP servers, and the desktop app, CLI, and IDE
   extension share their MCP configuration. This is the supported way to let an
   active Codex conversation call a third-party workflow. [OpenAI's Codex MCP
   documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
2. Have the Coloop bridge start a **fresh** Codex App Server thread for the
   Episode Agent, with only the Context Package as its initial input and an
   isolated episode working directory. App Server is specifically documented as
   the interface for embedding Codex into a product with authentication,
   history, approvals, and streamed events. [OpenAI's Codex App Server
   documentation](https://learn.chatgpt.com/docs/app-server)
3. Translate Discord messages into App Server turns and stream Episode Agent
   messages back to the Discord thread. App Server provides `thread/start`,
   `turn/start`, `turn/steer`, item deltas, approval requests, user-input
   requests, and a terminal `turn/completed` event. [OpenAI's lifecycle and
   event documentation](https://learn.chatgpt.com/docs/app-server)
4. On the Owner's explicit Discord finalization action, run a final turn with an
   `outputSchema` matching the Episode Outcome contract, validate and persist
   it, then make it available through `get_episode_outcome`. `outputSchema` is a
   per-turn App Server feature; it constrains the generated result but does not
   itself implement ownership or finalization authority. [OpenAI's App Server
   turn documentation](https://learn.chatgpt.com/docs/app-server)

For an ordinary Codex desktop, CLI, or IDE Origin Session, the supported return
is an explicit MCP tool result: the Origin Session calls
`get_episode_outcome`, receives the structured result, and continues from it.
If Coloop itself owns the Origin Session through App Server, it can instead add
the outcome with a new `turn/start` request, or add prebuilt model-visible items
with `thread/inject_items`. The official surfaces do not document a way for an
external service to push an unsolicited outcome into an arbitrary, already-open
Codex UI conversation. [OpenAI's MCP client
documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and
[App Server turn documentation](https://learn.chatgpt.com/docs/app-server)

The recommended v0 is therefore a **bounded delegate**, not a migrated session:
start a new App Server thread and explicitly serialize only the approved Context
Package. App Server can resume or fork stored Codex threads, but a fork copies
stored history; using that as the episode boundary would deliberately carry more
Origin Session context than the product promises. [OpenAI's App Server thread
documentation](https://learn.chatgpt.com/docs/app-server)

## Recommended validation topology

```text
Origin Session
  -> Coloop MCP: open_episode(Context Package)
  -> Coloop bridge creates Discord thread + fresh App Server thread

Discord thread
  <-> Coloop bridge
  <-> Episode Agent (Codex App Server over local STDIO)

Owner finalizes in Discord
  -> schema-constrained Episode Outcome is persisted
  -> Coloop MCP: get_episode_outcome(episode_id)
  -> Origin Session receives the outcome
```

Run the Discord bridge and `codex app-server` on the same machine and connect
them over STDIO. STDIO is the default listed App Server transport, while direct
WebSocket is explicitly experimental and unsupported. The same documentation
also says the `app-server` command is experimental and unsupported for
production workloads, so this topology is appropriate for validation and
prototyping, not yet a production support promise. App Server should never be
Coloop's public network protocol. [OpenAI's App Server transport
documentation](https://learn.chatgpt.com/docs/app-server)

A local validation release can run the entire topology on the Owner's machine.
The machine must stay awake and connected because the SDK and App Server control
local Codex processes. A VPS can run the same bridge and Codex subprocess over
STDIO; that removes dependence on the Owner's laptop, but the Episode Agent sees
the VPS's files and working directory, not the Origin Session's repository or
environment unless Coloop deliberately transfers approved artifacts. App Server
accepts a per-thread/per-turn `cwd`, sandbox policy, writable roots, restricted
readable roots, and network access policy. [OpenAI's Codex SDK
documentation](https://learn.chatgpt.com/docs/codex-sdk) and [App Server sandbox
documentation](https://learn.chatgpt.com/docs/app-server)

## Supported seams

### Coloop MCP server: open and retrieve from an active Origin Session

Codex supports third-party MCP tools through local STDIO or remote Streamable
HTTP servers. A project can scope MCP configuration in `.codex/config.toml` for
trusted projects, while the default user configuration is in
`~/.codex/config.toml`. Streamable HTTP supports bearer-token and OAuth
authentication. [OpenAI's Codex MCP
documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

This makes a small Coloop MCP contract the cleanest Codex-first adapter:

- `open_episode(context_package)` creates the durable Collaboration Episode and
  returns an `episode_id` and Discord thread link.
- `get_episode_status(episode_id)` reports whether the episode is open,
  finalized, cancelled, or failed.
- `get_episode_outcome(episode_id)` returns the validated Episode Outcome after
  finalization.

Those tool names and payloads are Coloop design choices, not OpenAI-provided
methods. MCP supplies the supported invocation seam; Coloop must implement
episode persistence, Discord, authorization, finalization, and retry semantics.

An MCP call does not automatically receive the Origin Session's hidden prompt,
full transcript, repository, or tool state. The Origin Session must construct
the explicit tool arguments, which is desirable here because the Context
Package is owner-approved. The official MCP documentation describes access to
third-party tools and context, but no whole-session export primitive. [OpenAI's
Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### Codex App Server: run the Episode Agent

App Server is the strongest fit for a Discord-hosted conversation because it is
the documented deep-integration surface behind rich Codex clients. Its thread,
turn, and item model supports starting and resuming conversations, adding one
Discord message as a turn, steering an in-flight turn, streaming text and tool
progress, interrupting work, and observing completed, interrupted, or failed
turns. [OpenAI's App Server lifecycle
documentation](https://learn.chatgpt.com/docs/app-server)

This functional fit has a material maturity caveat: OpenAI's current transport
section says the `app-server` command and WebSocket transport are experimental
and unsupported for production workloads. A disposable prototype can rely on
the default local STDIO transport, but the production specification must either
validate a stable SDK abstraction with the required controls, choose a metered
API-based agent runtime, or gate implementation on App Server support maturity.
[OpenAI's App Server transport
documentation](https://learn.chatgpt.com/docs/app-server)

It also exposes the controls the episode adapter needs:

- Per-turn JSON Schema output through `outputSchema`, suitable for producing the
  Episode Outcome at finalization. [OpenAI's turn
  documentation](https://learn.chatgpt.com/docs/app-server)
- Command and file-change approval requests, each scoped by thread and turn,
  which a client can surface to the Owner instead of silently granting.
  [OpenAI's approval
  documentation](https://learn.chatgpt.com/docs/app-server)
- Short user-input questions and MCP elicitation requests that a client can
  render in Discord. `tool/requestUserInput` is experimental, so the v0 contract
  should not depend on it for ordinary collaborator messages. [OpenAI's input
  request documentation](https://learn.chatgpt.com/docs/app-server)
- Explicit filesystem and network sandbox policies. An isolated episode
  directory plus restricted read access can ensure the Episode Agent does not
  inherit the Origin Session's repository by accident. [OpenAI's sandbox
  documentation](https://learn.chatgpt.com/docs/app-server)

App Server returns loaded instruction-file paths on thread start, resume, and
fork. Coloop should therefore give the Episode Agent a purpose-built episode
working directory and audit its instruction sources; pointing it at the Origin
Session repository would load repository instructions and broaden the Context
Package. [OpenAI's thread-start
documentation](https://learn.chatgpt.com/docs/app-server)

Persist the mapping from Coloop's `episode_id` to the App Server `thread.id`.
The documented `thread/resume` operation reopens a stored thread by ID so later
turns append to it, which supports process restarts between Discord messages.
This does not define recovery for a process crash during an active turn; Coloop
still needs an explicit retry and orphan-recovery policy. [OpenAI's thread
continuity documentation](https://learn.chatgpt.com/docs/app-server)

### Codex SDK: a simpler wrapper, not a separate hosted API

The TypeScript Codex SDK programmatically starts, continues, and resumes **local**
Codex threads and is documented for server-side Node.js. The Python SDK controls
the local App Server over JSON-RPC and ships with a pinned Codex CLI runtime.
[OpenAI's Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)

The SDK is suitable for a bridge if Coloop only needs to run prompts and collect
final responses. OpenAI describes the Python SDK as stable and directs job and
CI automation to the SDK, while directing deep product integrations needing
authentication, history, approvals, and streamed events to App Server. The
published SDK page does not establish that its stable high-level API exposes all
of the bidirectional approvals and event controls needed by the Discord
experience, so that question requires a disposable prototype before treating
the SDK as the production escape hatch. [OpenAI's Codex SDK
documentation](https://learn.chatgpt.com/docs/codex-sdk) and [App Server
documentation](https://learn.chatgpt.com/docs/app-server)

Installing `@openai/codex-sdk` or `openai-codex` does not by itself choose API
billing. These packages control a local Codex runtime; that runtime's login mode
determines whether usage consumes ChatGPT plan allowance or uses a Platform API
key. This conclusion follows from the SDK's documented local-runtime design and
Codex's two documented login modes. [OpenAI's SDK
documentation](https://learn.chatgpt.com/docs/codex-sdk) and [Codex
authentication documentation](https://learn.chatgpt.com/docs/auth)

### Codex MCP server plus Agents SDK: supported, but unnecessary for v0

Codex itself can run as an MCP server. It exposes `codex` to start a conversation
and `codex-reply` to continue one by thread ID; results include structured
content containing the thread ID and response text. OpenAI documents combining
this with the Agents SDK for multi-agent orchestration, handoffs, guardrails,
and traces. [OpenAI's Codex-as-MCP
documentation](https://learn.chatgpt.com/docs/mcp-server)

The official Agents SDK walkthrough requires a Platform API key for the
orchestrating agents and starts a long-running local `codex mcp-server` process.
That makes this a metered, additional orchestration layer rather than a way to
reuse a ChatGPT subscription alone. It is useful only if a later design needs a
separate orchestrator or multiple specialist agents; App Server already provides
the Discord episode lifecycle needed for v0. [OpenAI's Agents SDK with Codex
walkthrough](https://learn.chatgpt.com/docs/mcp-server)

## Authentication, subscription, and API billing

Codex supports two normal login modes for local work: ChatGPT login for
subscription access and API-key login for usage-based access. ChatGPT desktop,
Codex CLI, and the IDE extension support both; the sign-in method also selects
the applicable workspace controls and data policies. [OpenAI's Codex
authentication documentation](https://learn.chatgpt.com/docs/auth)

App Server exposes both choices directly. It supports API-key login, ChatGPT
browser login, and a ChatGPT device-code flow intended for clients that own the
sign-in ceremony or cannot rely on a browser callback. Its externally managed
`chatgptAuthTokens` mode is explicitly experimental and should not be a v0
dependency. [OpenAI's App Server login
documentation](https://learn.chatgpt.com/docs/app-server)

With ChatGPT login, Codex uses the Owner's included plan allowance. Codex is
included in ChatGPT Free, Go, Plus, Pro, Business, Edu, and Enterprise plans,
but the allowance is plan- and workload-dependent, shared across local messages
and cloud chats in a five-hour window, and may also have weekly limits. Episode
Agent turns therefore consume the Owner's Codex allowance; a subscription is
not an unlimited capacity pool. [OpenAI's Codex pricing and limits
documentation](https://learn.chatgpt.com/docs/pricing)

With an API key, OpenAI bills the Platform account at standard API rates rather
than using included ChatGPT plan credits. Model availability follows the API
models available to that key, and API-key authentication lacks Codex
cloud-based features such as hosted Slack integration and GitHub code review.
Those missing cloud features do not prevent the local App Server bridge proposed
here. [OpenAI's authentication
documentation](https://learn.chatgpt.com/docs/auth) and [Codex pricing
documentation](https://learn.chatgpt.com/docs/pricing)

OpenAI explicitly recommends API-key authentication for programmatic Codex CLI
workflows such as CI/CD. For ChatGPT Enterprise, Codex access tokens are the
documented non-interactive option when trusted local automation needs
ChatGPT-managed entitlements and workspace controls; general OpenAI API calls
still use Platform API keys. [OpenAI's automation authentication
documentation](https://learn.chatgpt.com/docs/auth)

Codex caches ChatGPT or API-key login locally in the OS credential store or
`~/.codex/auth.json`. A VPS using owner subscription auth therefore needs a
secure per-owner credential lifecycle, while API-key hosting needs the usual
secret storage and spend controls. The official docs establish the mechanisms,
but not whether a consumer subscription may be used as inference for a
multi-tenant commercial service; that policy and terms question must be decided
separately before hosted production. [OpenAI's login caching
documentation](https://learn.chatgpt.com/docs/auth)

### Practical choice by release shape

| Release shape | OpenAI authentication | Billing consequence | Availability consequence |
| --- | --- | --- | --- |
| Owner-operated local validation bridge | Owner signs App Server/Codex in with ChatGPT | Draws from the Owner's included, rate-limited Codex plan allowance | Owner machine and bridge must remain online |
| Single-owner VPS experiment | Owner completes App Server's ChatGPT device-code login on the VPS | Still draws from that Owner's plan allowance | VPS stays online, but credential rotation and plan exhaustion are operational risks |
| Shared/unattended hosted service | Platform API key, unless eligible Enterprise automation deliberately uses a Codex access token | Metered API usage for API-key mode; Enterprise entitlement rules for access-token mode | Requires per-owner or service billing, quotas, spend controls, a decided tenancy model, and a production-supported runtime |

The login and billing facts in this table come from [OpenAI's Codex
authentication documentation](https://learn.chatgpt.com/docs/auth), [App Server
login documentation](https://learn.chatgpt.com/docs/app-server), and [Codex
pricing documentation](https://learn.chatgpt.com/docs/pricing). The operational
consequences are architectural inferences from those documented mechanisms.

## Unsupported or unproven paths

- **Literal session migration to Discord:** the official surfaces create,
  resume, or fork Codex threads; they do not move the running agent process,
  hidden prompt, complete tool state, or environment into Discord. [OpenAI's App
  Server thread documentation](https://learn.chatgpt.com/docs/app-server)
- **Automatic extraction of the Context Package:** MCP lets Codex call tools,
  but no documented tool argument automatically contains the full Origin
  Session. Context selection and Owner approval remain Coloop behavior.
  [OpenAI's Codex MCP
  documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- **Unsolicited return into any existing Codex UI session:** a configured MCP
  server can answer a tool call, and an App Server client can add a new turn to a
  thread it controls. No consulted official surface documents arbitrary
  third-party push into an unrelated open desktop, CLI, or IDE conversation.
  [OpenAI's Codex MCP
  documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [App
  Server documentation](https://learn.chatgpt.com/docs/app-server)
- **First-party Discord transport:** current official Codex pricing documents a
  cloud Slack integration but no Discord integration. Discord participation
  therefore requires a Coloop-owned Discord bot and message adapter. [OpenAI's
  Codex pricing documentation](https://learn.chatgpt.com/docs/pricing)
- **Production reliance on the direct App Server command:** OpenAI marks the
  `app-server` command and WebSocket transport experimental and unsupported for
  production. Local STDIO avoids the additional remote-transport risk, but does
  not erase the documented command-level maturity caveat. Keep App Server local
  to the Coloop bridge during validation and expose only Coloop's own
  authenticated service boundary. [OpenAI's App Server transport
  documentation](https://learn.chatgpt.com/docs/app-server)
- **Additional experimental App Server features as core lifecycle dependencies:** dynamic
  tools, direct externally managed ChatGPT tokens, and several user-input APIs
  require `experimentalApi`. The core thread, turn, streaming, approval, and
  output-schema primitives are documented without that capability opt-in, but
  the App Server command's overall production caveat still applies. [OpenAI's
  App Server experimental API documentation](https://learn.chatgpt.com/docs/app-server)

## Constraints to carry into the v0 specification

1. **Fresh episode thread:** never resume or fork the Origin Session into a
   Collaboration Episode. Serialize the approved Context Package into a new
   thread.
2. **Explicit return protocol:** promise “no transcript copying,” not invisible
   push. The baseline is an `episode_id` plus explicit outcome retrieval in the
   Origin Session. A blocking `open_episode` call that remains pending for an
   unbounded Discord discussion is not documented as reliable and should not be
   the baseline.
3. **Isolated authority:** create a dedicated episode working directory and
   restrictive sandbox. Add artifacts or repository access only when the Owner
   approves them as part of the Context Package.
4. **Owner-gated privileged actions:** route command, file, network, and
   finalization approvals to the Owner, not any Collaborator. App Server supplies
   approval events; Coloop supplies identity and policy.
5. **One sequential agent turn per Discord input batch:** App Server can steer an
   active turn, but normal conversation should queue or batch messages so the
   adapter has one authoritative turn lifecycle and outcome ordering.
6. **Persist Coloop state separately:** persist `episode_id`, Discord thread ID,
   App Server thread ID, lifecycle state, accepted artifacts, and the validated
   Episode Outcome. Codex thread persistence is not the Collaboration Episode's
   domain record.
7. **Treat usage exhaustion as a lifecycle failure:** App Server exposes
   `UsageLimitExceeded` among its errors, so retry, timeout, and orphan recovery
   must distinguish capacity exhaustion from transport or agent failure.
   [OpenAI's App Server error
   documentation](https://learn.chatgpt.com/docs/app-server)

## Implications for downstream map decisions

- The execution-seam decision can assume **Coloop MCP at the Origin Session plus
  a fresh Codex App Server thread for the Episode Agent** as the validation
  feasibility baseline. It cannot yet assume direct App Server is a supported
  production runtime.
- Deployment topology now has two credible modes: an Owner-operated local bridge
  using subscription auth for validation, and an always-on bridge using a
  separately chosen hosted credential/billing model. The latter also needs a
  production-runtime decision; remote App Server WebSocket exposure should not
  be one of the options.
- The lifecycle ticket must define explicit outcome retrieval, reconnect/resume,
  message queueing, active-turn interruption, usage-limit failure, and orphan
  handling. OpenAI supplies events and thread continuity, not those domain
  semantics.
- The trust-boundary ticket must decide the episode sandbox, which artifacts are
  copied into it, which App Server approvals can be answered from Discord, and
  how Owner identity is bound across Codex and Discord.
- The final specification should distinguish four credentials: Discord bot
  credential, Coloop user/session credential, Codex ChatGPT or Enterprise access
  token, and optional Platform API key. They are not interchangeable.

## Newly precise decision questions

1. **Return UX:** Is an explicit `get_episode_outcome(episode_id)` tool call in
   the Origin Session acceptable for v0, or must Coloop own the Origin Session
   through App Server so it can append the Episode Outcome automatically?
2. **Hosted inference tenancy:** Does each Owner authenticate an individual Codex
   entitlement on the bridge, or does Coloop operate a centrally billed Platform
   API project for Episode Agent usage?
3. **Episode execution authority:** Is the Episode Agent limited to the Context
   Package in an isolated directory, or can an Owner explicitly grant read or
   write access to an Origin Session working copy for selected episodes?
4. **Commercial subscription boundary:** Is v0 strictly an Owner-operated tool,
   or will collaborators interact with a centrally hosted service whose use of
   one Owner's consumer subscription requires a product-policy and terms review?
5. **Production Episode Agent runtime:** Can the stable Codex SDK support the
   required multi-turn streaming, approval, and schema-output loop without
   depending on direct experimental App Server APIs, or must hosted production
   use a metered Responses/Agents SDK runtime until App Server reaches supported
   production maturity?
