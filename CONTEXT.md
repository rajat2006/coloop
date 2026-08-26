# Coloop

Coloop enables an owner to involve other people in bounded parts of ongoing
AI-agent work without giving up end-to-end ownership of that work.

## Language

**Owner**:
The person accountable for the work who retains authority over the originating
agent interaction and its outcomes.
_Avoid_: Host, administrator

**Owner Pairing**:
The durable association between a Coloop installation's owner and the owner's
Discord user identity in its configured server, used to authenticate episode
control.
_Avoid_: Thread ownership, installer identity, display-name match

**Collaborator**:
A person temporarily invited to advise, review, or approve part of an owner's
work without assuming ongoing ownership of it.
_Avoid_: Co-owner, operator

**Collaboration Episode**:
A bounded exchange opened from ongoing agent work to obtain input from one or
more collaborators, ending with an outcome returned to the owner.
_Avoid_: Session, handoff, meeting

**Episode Phase**:
The owner-visible position of a collaboration episode in its business
lifecycle, independent of transient agent and infrastructure operation status.
_Avoid_: Operation status, health status

**Episode Agent**:
An AI agent delegated to participate in one collaboration episode using only
the context and authority granted to that episode.
_Avoid_: Origin agent, bot

**Context Package**:
An immutable, owner-authorized snapshot of the visible text exchanged in an
origin session through the opening request, made available to its collaboration
episode.
_Avoid_: Full agent state, repository snapshot, prompt dump

**Episode Control**:
The owner's exclusive authority to change a collaboration episode's objective
or context and to finalize or cancel it; conversational participation does not
exercise episode control.
_Avoid_: Participation, moderation, shared ownership

**Outcome Proposal**:
The current, revisable candidate for a collaboration episode's result while the
episode remains active.
_Avoid_: Episode Outcome, final answer, transcript summary

**Episode Outcome**:
The immutable structured text accepted by the owner when finalizing a
collaboration episode, comprising its conclusion and any unresolved points.
_Avoid_: Outcome Proposal, transcript, summary, final answer

**Origin Session**:
The owner's ongoing interaction with an AI agent from which a collaboration
episode is opened and to which its outcome returns.
_Avoid_: Discord thread, collaboration episode

**Singular Ownership**:
The principle that one owner remains accountable for work end to end even when
collaborators participate in parts of it.
_Avoid_: Solo work, shared ownership
