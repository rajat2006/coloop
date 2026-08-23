# Wayfinder artifact publication

Wayfinder decisions must arrive with their supporting repository artifacts. This policy extends `/wayfinder` while planning or resolving a map, writing its PRD, and implementing that PRD.

This policy applies to future Wayfinder work and does not migrate, delete, or reclassify existing research or prototypes on the default branch.

## Publication surfaces

A map may have one shared branch and draft PR per artifact class. Create one only when its first artifact appears.

| Class | Shared branch | Contents | Lifecycle |
| --- | --- | --- | --- |
| **Decision-document PR** | `wayfinder/map-<map-number>-decision-documents` | Maintained documentation: `CONTEXT.md`, ADRs, and other project docs | Mergeable. Keep draft while decisions accumulate; it may remain unmerged during decomposition or implementation. |
| **Research-and-prototype PR** | `wayfinder/map-<map-number>-research-and-prototypes` | Cited research and accepted, rejected, or inconclusive prototypes, including runnable files and verdicts | Keep draft, then close without merging when its review surface is no longer useful. |

Use the immutable map number in branch names. Base both PRs on the default branch, link the map in each PR body, and reuse the class's map-level PR for every ticket.

Legacy artifact PRs that predate the shared-branch convention must carry the
`wayfinder:artifact` label while they remain open. The Daily Project Digest uses
that maintainer-owned marker to keep those PRs as evidence of their map instead
of reporting them as independent delivery work.

Raw research belongs in the research-and-prototype PR. Promote durable findings by expressing them in maintained documentation on the decision-document PR. Preserve rejected, unsuccessful, and inconclusive work when its evidence or limits explain a decision.

## Publish one ticket

Publish each artifact-producing ticket from a temporary ticket-local branch. If a ticket produces both classes, use a separate branch and commit for each so their files never mix.

For each class:

1. Resolve the map number, artifact class, shared branch, and existing PR before editing. Create a uniquely named ticket-local branch from the latest remote shared branch, or the remote default branch if the shared branch does not exist.
2. Create or update only the ticket's artifacts. Make prototypes inspectable and runnable; record each verdict as accepted, rejected, or inconclusive.
3. Inspect and stage the complete artifact set, then create one ticket-attributable commit whose message includes the ticket number.
4. Immediately before integration, fetch and rebase onto the latest remote shared branch—or the remote default branch for the first publication—then rerun relevant checks.
5. Fast-forward push the ticket commit to the shared branch. Never force-push. If rejected, another session won the race: fetch, rebase onto the updated branch, rerun checks, resolve all conflicts, and retry.
6. For the class's first publication, open a draft map-level PR. If another session created it, reuse it. Confirm the commit and PR are reachable on GitHub.
7. After the final rebase, copy the commit's full SHA. Create and open a pinned GitHub file permalink for every relevant artifact before resolving the ticket.

Later corrections require a new ticket-attributable commit and new permalinks; never rewrite linked history.

## Record the resolution

Resolve an artifact-producing ticket only when:

- its final commit is reachable on the correct shared branch;
- the map-level draft PR exists;
- every relevant artifact has a verified, immutable file-at-commit permalink; and
- both the resolution comment and parent map contain the PR URL and artifact permalinks.

Use this resolution shape:

```markdown
## Resolution

<answer and verdict>

## Artifacts

- <Decision-document PR or Research-and-prototype PR>: <stable PR URL>
- [<artifact path>](<full-commit file permalink>) — <contribution>
```

Append the ticket to the map's **Decisions so far** as `/wayfinder` requires. Keep the entry to a one-line decision gist, ticket link, PR URL, and direct artifact permalinks; the map indexes primary artifacts instead of copying them.

A ticket with no repository artifact follows the normal Wayfinder flow and creates no branch or PR.

## Build the implementation handoff

Generate the final PRD only after every map ticket is resolved and the artifact set is settled. Keep selected behavior self-contained, then add a **Wayfinder sources** manifest with:

- the parent map's stable URL;
- each map-level artifact PR, labeled by class;
- an explicit note for decision documents absent from the PRD's base branch; and
- every implementation-relevant file-at-commit permalink, grouped by source ticket.

The manifest provides evidence and rationale; it does not replace implementation decisions. After an exceptional post-publication decision change, publish a new artifact commit and pin it in the manifest before further implementation.

Implementation treats the versions pinned by the PRD as authoritative, including unmerged decision documents, and reads them through their GitHub permalinks. Keep decision-document history independently mergeable; do not cherry-pick its commits into the implementation branch. The decision-document PR need not merge before decomposition or implementation.

## Close or abandon a map

Closing a research-and-prototype PR is a manual user action. After implementation, close it without merging when its review surface is no longer useful; neither its PR nor branch is closed or deleted automatically. Publish findings that must endure as a separate maintained-documentation change.

If a map is abandoned before a PRD exists, close its research-and-prototype PR without merging. Review the decision-document PR independently: retain it for review, merge still-valid documentation, or close it. Record the disposition on the map.

## Review walkthroughs

Before completing a policy or PRD change, verify unambiguous publication, links, and lifecycle for:

- research-only work, including an inconclusive result;
- a prototype with a preserved rejected variant and verdict;
- grilling or domain modeling that changes an ADR or `CONTEXT.md`;
- concurrent tickets publishing to one shared branch;
- implementation using an unmerged decision document through a pinned permalink; and
- an abandoned map with one or both artifact PR classes.
