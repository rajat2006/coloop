# TASK

Survey this repository at its current `{{BASE_BRANCH}}` checkout and find the **single
freshest deepening opportunity** — one shallow module that could become a deep
one — then write it up as a **complete PRD** a maintainer can hand straight to
`agent:to-issues`. If there is nothing fresh worth proposing, say so and skip.

This is the autonomous, GitHub-native form of an architecture review. It runs on
a schedule with no human in the loop, so it is a **read-only survey**: do **not**
edit code, do **not** commit, do **not** produce an HTML report, do **not** open
or wait on anything interactive, and do **not** touch any `gh` or label state.
Your entire job is to reason about the codebase and, in a later turn, emit one
structured decision.

**Do not run the `/improve-codebase-architecture` skill** — it is built for an
interactive session (HTML report + grilling a human through candidates) and does
not fit an autonomous run. Instead do the analysis directly, using the
**`/codebase-design` deep-module vocabulary** as your reference for the terms
(*module*, *interface*, *depth*, *seam*, *adapter*, *leverage*, *locality*) and
the principles (the deletion test; "the interface is the test surface"). You may
read `.agents/skills/codebase-design/` for those definitions; do not invoke it as
an interactive flow.

# CONTEXT

This is a whole-tree sweep on `{{BASE_BRANCH}}`, not a diff review. Orient yourself:

```
git log --oneline -20
git ls-files | sed -n '1,200p'
```

Read the domain model and the recorded decisions first — a good proposal names
real seams and does not re-litigate settled calls:

- `CONTEXT.md` — the ubiquitous language. Name modules by their real domain names
  (if `CONTEXT.md` defines "Stop", talk about "the Stop intake module").
- `docs/adr/` — the ADRs record decisions this review **must not re-propose**. A
  proposal that contradicts an accepted ADR is out of bounds.

## Already-proposed opportunities — do NOT re-propose any of these

These architecture-review PRDs have already been proposed — **open and closed
alike** (accepted, completed, or explicitly rejected). Your proposal must be
**materially different** from every one of them; re-raising a closed idea is
exactly the duplicate this list exists to prevent. If the only opportunity you
can find is already covered here, that is a **skip**, not a duplicate.

{{EXISTING_PROPOSALS}}

# LIFECYCLE

### 1. Survey

Use the `Explore` sub-agent to walk the codebase organically and note where you
feel friction. Look for **shallow modules** (interface nearly as complex as the
implementation), concepts that force bouncing between many small modules, pure
functions extracted only for testability where the real bugs hide in how they're
called (no **locality**), and tightly-coupled modules leaking across a seam.

Apply the **deletion test** to anything you suspect is shallow: would deleting it
*concentrate* complexity, or just move it? A "concentrates" is the signal.

### 2. Pick the single best fresh opportunity

Weigh the candidates you turned up and choose the **one** with the most leverage
that is **not** already a past proposal above. Keep track of the handful you
seriously considered — you'll report them as `candidatesConsidered`. Prefer one
high-signal, load-bearing candidate over a list of shallow ones. If nothing
clears that bar this run — the codebase is clean, or every candidate is already
proposed — that is a valid, honest **skip**.

### 3. Write it up as a complete PRD

For the chosen opportunity, draft a PRD body a maintainer could hand straight to
`agent:to-issues`. Write **every** section below, in this order, in
`/codebase-design` and `CONTEXT.md` vocabulary, referencing real **modules,
interfaces, and ADRs by name**. Each section must be **substantive** — a reader
who has never seen the codebase should understand the problem and the plan. A
structurally complete but thin sketch (headings with one hand-wavy line each) is
a failure; prefer to **skip** over shipping a shallow PRD.

**Talk in modules and interfaces — not file paths or code.** Name the domain
concept and the seam ("the Stop intake module", "the extraction interface"), not
`src/foo/bar.ts`. File paths and code snippets go **stale** the moment a file
moves, and this PRD may sit in the backlog for weeks before anyone acts on it.
The one narrow exception: a short **prototype interface sketch** — a handful of
signature lines showing the small surface you're proposing — is allowed in the
Solution or Implementation Decisions section, because that sketch *is* the
proposal. No other code, and no `path/to/file` line references anywhere.

- **Problem Statement** — written from the *user's* perspective (the maintainer
  or agent living with the code): the concrete friction the shallow module causes
  *today*. Name the module. Show *why* it's shallow: apply the deletion test
  (would deleting it concentrate complexity or just move it?), and describe the
  bouncing-between-modules or leaked-seam symptom someone hits. Cite the
  `CONTEXT.md` terms and any ADR the current shape strains.
- **Solution** — written from the user's perspective too: what gets *easier*
  once this is deepened. The deepening itself — which behaviour moves *behind*
  which interface, at which seam; what the new interface looks like (the small
  surface, optionally a prototype signature sketch) and what complexity it now
  hides. Contrast before/after in terms of *depth*, *leverage* for callers, and
  *locality* for maintainers.
- **User Stories** — a **numbered list**, as long as it needs to be to cover
  *every* aspect of the change (not a fixed four). Give each stakeholder as many
  stories as the deepening touches — the maintainer, the autonomous agent
  navigating the code, the reviewer, the test author, and anyone else affected.
  Frame **each** as "As a …, I want …, so that …".
- **Implementation Decisions** — the concrete design calls: the exact **modules**
  touched, the interface signature(s), what deliberately stays *out* of the
  interface, migration/rollout order, and which **callers** must change (name them
  by module, not path). Enough that decomposing this into child issues is
  mechanical.
- **Testing Decisions** — how the deepened module is tested *through its
  interface* (the interface is the test surface), what becomes newly testable, and
  which existing tests move or retire. Name the test harness this repo uses.
- **Out of Scope** — adjacent deepenings, refactors, or modules this PRD
  deliberately does *not* touch, so the change stays scoped to this one seam.
- **Further Notes** — ADR ties (which decisions this respects or would amend),
  follow-up opportunities it unlocks, and the risks or unknowns a builder should
  watch.

Keep it scoped to this one deepening — not a grab-bag.

# REPORTING

Reason in prose throughout — do **not** emit any JSON or `<output>` block yet. A
separate follow-up turn will ask you to emit the structured decision (the PRD and
the candidates considered, or the skip reason).
