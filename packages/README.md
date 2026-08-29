# Package responsibilities

The workspace is organized by responsibility. The CLI composes the system,
while shared packages do not import vendor implementation packages.

```text
packages/
├── cli/                                      # Executable shell and composition root
│   └── src/
│       ├── main.ts                           # Dispatches public and integration entry points
│       ├── run-cli.ts                        # Parses CLI commands and reports failures
│       ├── black-box.test.ts                 # Exercises the built executable as a child process
│       ├── dependencies.ts                   # Defines the services required by CLI flows
│       ├── production-dependencies.ts        # Wires production implementations together
│       ├── readiness.ts                      # Performs the shared startup/readiness inspection
│       ├── readiness.test.ts                 # Verifies complete and failed readiness results
│       ├── commands/
│       │   ├── setup.ts                      # Runs the interactive installation flow
│       │   ├── setup.test.ts                 # Verifies setup, recovery, privacy, and permissions
│       │   ├── run.ts                        # Starts the ready foreground runtime
│       │   └── run.test.ts                   # Verifies runtime gating and Gateway cleanup
│       ├── system/
│       │   ├── environment.ts                # Removes secrets from child-process environments
│       │   ├── open-browser.ts               # Opens Owner-action URLs with the host OS
│       │   ├── processes.ts                   # Runs Codex and Coloop subprocesses
│       │   └── shutdown.ts                    # Waits for process termination signals
│       ├── terminal/
│       │   └── terminal.ts                   # Provides terminal prompts and output
│       └── test-support/
│           ├── fake-codex.mjs                # Simulates Codex CLI for executable tests
│           ├── fake-open.mjs                 # Records browser launches for executable tests
│           └── provider-preload.mjs           # Simulates provider network APIs for executable tests
├── core/                                     # Shared Coloop policy and domain types
│   └── src/
│       ├── index.ts                          # Exposes the core package's public API
│       ├── result.ts                         # Defines shared discriminated result shapes
│       ├── discord-ids.ts                    # Validates and distinguishes Discord identities
│       ├── discord-ids.test.ts               # Verifies Discord snowflake validation
│       └── installation/
│           ├── installation-config.ts        # Defines configuration and readiness invariants
│           └── installation-config.test.ts   # Verifies complete and incomplete configuration
├── coding-agents/                            # Coding-agent protocols and client integrations
│   ├── protocol/
│   │   └── src/
│   │       ├── index.ts                      # Exposes the protocol package's public API
│   │       ├── server.ts                     # Serves the agent-neutral Coloop MCP contract
│   │       └── server.test.ts                # Verifies MCP initialization and tool discovery
│   └── codex/
│       └── src/
│           ├── index.ts                      # Exposes the Codex package's public API
│           ├── hooks.ts                      # Validates Codex hook events and trusted context
│           ├── hooks.test.ts                 # Verifies hook identity and fail-closed behavior
│           ├── installation.ts               # Installs and verifies Codex CLI integration
│           └── installation.test.ts          # Verifies installation and external JSON validation
├── agent-runtimes/                           # SDK-backed runtimes used by Episode agents
│   └── openai-agents/
│       └── src/
│           ├── index.ts                      # Owns OpenAI runtime credentials and future SDK setup
│           └── index.test.ts                 # Verifies credential outcome classification
├── collaboration-channels/                   # External collaboration transports
│   └── discord/
│       └── src/
│           ├── index.ts                      # Owns Discord API, Gateway, and permission policy
│           └── index.test.ts                 # Verifies payload and least-privilege validation
└── storage/                                  # Persistence implementations
    └── local/
        └── src/
            ├── index.ts                      # Exposes the local-storage package's public API
            ├── local-storage.ts              # Owns local config, SQLite, and artifact paths
            └── local-storage.test.ts         # Verifies private config and storage readiness
```

Additional coding clients such as Claude Code or Cursor belong beside `codex`.
They should share the protocol package, but keep their installation and hook
details inside their own packages. The OpenAI Agents SDK belongs under
`agent-runtimes` because it runs Coloop's Episode agents; it is not a coding
client integration.
