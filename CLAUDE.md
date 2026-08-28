# coloop

Use the project-local skills under `.agents/skills/`.

## Agent skills

### Coding standards

Coding standards live in `.agents/skills/coding-standards/`. Load that skill
before writing code, reviewing changes, or answering questions about repository
conventions.

### Issue tracker

Issues and specs are tracked in GitHub Issues for `rajat2006/coloop`. See
`docs/agents/issue-tracker.md`.

### Wayfinder tickets

If a ticket is a wayfinder ticket (labelled `wayfinder:*`), consult the `/wayfinder` skill for how to resolve it — even when you were invoked via another skill such as `/grill-with-docs`.

For Wayfinder planning, ticket resolution, PRD handoff, or implementation from a Wayfinder PRD, read the [Wayfinder artifact publication policy](docs/agents/wayfinder-artifacts.md).

### Triage labels

Use the five default labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus ADRs under `docs/adr/`. See
`docs/agents/domain.md`.
