# Selected Discord Collaboration Episode prototype

This disposable prototype captures the interaction selected through Owner
feedback:

1. Coloop opens with one friendly problem statement.
2. People discuss it normally and tag Coloop when they need source context.
3. The Owner tags Coloop to draft an outcome from the discussion, including
   unresolved points.
4. Coloop posts one public, structured Outcome Proposal.
5. Collaborators review it in ordinary conversation and tag Coloop with
   corrections.
6. Coloop edits the same public proposal to a new revision and acknowledges the
   update inline.
7. The Owner invokes `/finalize` to accept the exact visible revision as the
   immutable Episode Outcome and return it to Codex.

The Owner never has to manually format the conclusion or unresolved points.
Coloop synthesizes them on demand, not continuously. `/finalize` refuses when no
Outcome Proposal exists and is authorized only for the paired Owner.

Run from the repository root:

```bash
python3 -m http.server 4173 --directory prototypes/discord-collaboration-episode
```

Open <http://localhost:4173/>. Use the control row beneath Discord to advance
the walkthrough. At the final step, switch between Rajat and Maya to test the
Owner authorization boundary. The control row is prototype scaffolding, not
Discord UI.

The prototype uses only ordinary thread messages, mentions, an edited bot
message, a slash command, a public terminal message, and an ephemeral
authorization failure. See Discord's documentation for
[message edits](https://docs.discord.com/developers/resources/message#edit-message),
[application commands](https://docs.discord.com/developers/interactions/application-commands),
and [interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

This is throwaway UI evidence, not production code.
