# Coloop CLI

This package provides the v0 terminal entry points for one Owner-local Coloop
installation:

```bash
export DISCORD_TOKEN="..."
export OPENAI_API_KEY="..."
pnpm coloop setup
pnpm coloop run
```

`DISCORD_TOKEN` must belong to a dedicated Discord application.
`OPENAI_API_KEY` must belong to the Owner's OpenAI Platform project; it is not
the Owner's existing Codex CLI authentication. Both credentials are required
for every setup or runtime process and are never saved by Coloop.

The setup wizard configures exactly one Discord server, parent text channel,
and numeric Owner user ID. It requires the `Guilds`, `Guild Messages`, and
`Message Content` intents and these parent-channel permissions:

- View Channel
- Send Messages
- Create Private Threads
- Send Messages in Threads
- Read Message History
- Use Application Commands

Setup rejects Administrator and every permission outside that exact set. It
also creates Owner-private SQLite and Episode artifact locations, then
configures the hook and MCP entry points for Codex CLI 0.150.1. Codex IDE and
desktop clients are outside the v0 support boundary.

By default, non-secret configuration lives under
`$XDG_CONFIG_HOME/coloop/config.json` and durable local state under
`$XDG_STATE_HOME/coloop/`. When those XDG variables are absent, standard
per-user config and state directories are used.

Rerun plain `coloop setup` after any interruption. It revalidates saved
non-secret steps and continues at the first step that needs Owner action.
`coloop run` never repairs setup: it fails before opening the Discord Gateway
when any readiness check is missing or invalid.
