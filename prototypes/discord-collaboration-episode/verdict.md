# Verdict

**Status: accepted.**

## Selected behavior

- Opening is a friendly problem statement without detailed context, permission,
  lifecycle, or control UI.
- Participants obtain more Context Package detail by tagging Coloop.
- Coloop creates an Outcome Proposal only when the Owner asks for one in natural
  conversation.
- Coloop synthesizes both the conclusion and unresolved points; the Owner does
  not manually populate structured fields.
- The Outcome Proposal is public, so Collaborators can review it and request
  corrections by tagging Coloop.
- Coloop edits one canonical public proposal rather than posting competing
  proposals.
- Only the Owner's `/finalize` accepts the current visible revision as the
  immutable Episode Outcome. The command fails when no proposal exists.

## Rejected behavior

- Detailed opening cards, persistent control UI, custom Discord chrome, and
  continuously generated proposals add ceremony or are not native.
- Private-only proposals prevent Collaborators from checking the return value.
- Modal-based or manually structured outcome entry makes the Owner do synthesis
  that the Episode Agent can perform from the conversation.
- Text conventions requiring the Owner to author `Conclusion` and `Unresolved`
  sections are unnecessarily rigid.
- Selecting an existing message from a context menu hides a key action and may
  accept text that is not a self-contained outcome.
