# Coloop

Coloop enables an owner to involve other people in bounded parts of ongoing
AI-agent work without giving up end-to-end ownership of that work.

## Language

**Owner**:
The person accountable for the work who retains authority over the originating
agent interaction and its outcomes.
_Avoid_: Host, administrator

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
The owner-approved message prepared from an origin session and made available
to a collaboration episode, containing a question and its relevant context.
_Avoid_: Full session, repository snapshot, prompt dump

**Handoff Draft**:
The private, unapproved message preview prepared in an origin session for owner
review before a collaboration episode is opened.
_Avoid_: Context Package, draft episode

**Episode Outcome**:
The structured result returned from a finalized collaboration episode,
including its accepted answer or decision, accepted artifacts, and unresolved
points.
_Avoid_: Transcript, summary, final answer

**Origin Session**:
The owner's ongoing interaction with an AI agent from which a collaboration
episode is opened and to which its outcome returns.
_Avoid_: Discord thread, collaboration episode

**Singular Ownership**:
The principle that one owner remains accountable for work end to end even when
collaborators participate in parts of it.
_Avoid_: Solo work, shared ownership
