# coloop

## Agent skills

Project-local skills live under `.agents/skills/` and are sourced from
`mattpocock/skills`; `skills-lock.json` records the installed revisions.

Before using the engineering flow for the first time, run the local
`setup-matt-pocock-skills` skill to configure the issue tracker, triage labels,
and domain-document layout for this repository.

## Sandcastle agent platform

Autonomous GitHub issue and pull-request workflows live under
`.github/workflows/agent-*.yml`. Their runner seam is `.sandcastle/`; operational
setup, labels, and required secrets are documented in
`docs/agents/sandcastle.md`.
