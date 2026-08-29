# Package responsibilities

The workspace is organized by responsibility. The CLI composes the system,
while shared packages do not import vendor implementation packages.

```text
packages/
├── cli/                                      # Executable shell and composition root
│   └── src/
│       ├── main.ts                           # Dispatches public and integration entry points
│       ├── run-cli.ts                        # Parses CLI commands and reports failures
│       ├── run-cli.test.ts                   # Exercises setup and runtime through the CLI boundary
│       ├── black-box.test.ts                 # Exercises the built executable as a child process
│       ├── dependencies.ts                   # Defines the services required by CLI flows
│       ├── production-dependencies.ts        # Wires production implementations together
│       ├── commands/
│       │   ├── setup.ts                      # Runs the interactive installation flow
│       │   └── run.ts                        # Verifies readiness and starts the foreground runtime
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
│       ├── credential-error.ts               # Represents rejected provider credentials
│       └── installation/
│           └── installation-config.ts        # Defines configuration and readiness invariants
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
│           └── installation.ts               # Installs and verifies Codex CLI integration
├── agent-runtimes/                           # SDK-backed runtimes used by Episode agents
│   └── openai-agents/
│       └── src/index.ts                      # Owns OpenAI runtime credentials and future SDK setup
├── collaboration-channels/                   # External collaboration transports
│   └── discord/
│       └── src/index.ts                      # Owns Discord API, Gateway, and permission policy
└── storage/                                  # Persistence implementations
    └── local/
        └── src/
            ├── index.ts                      # Exposes the local-storage package's public API
            └── local-storage.ts              # Owns local config, SQLite, and artifact paths
```

Additional coding clients such as Claude Code or Cursor belong beside `codex`.
They should share the protocol package, but keep their installation and hook
details inside their own packages. The OpenAI Agents SDK belongs under
`agent-runtimes` because it runs Coloop's Episode agents; it is not a coding
client integration.
