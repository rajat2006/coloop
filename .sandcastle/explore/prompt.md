# TASK

Explore the repository to triage issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

This is a read-only first pass. Do not implement the change. Help a future
implementer understand whether the issue is accurate, how difficult it is, and
what must be resolved before work starts.

# ISSUE

The workflow fetched the complete issue and its discussion before removing
GitHub credentials from this agent step:

{{ISSUE_CONTEXT}}

# CONTEXT

Read the repository's durable guidance before assessing the issue:

- `CLAUDE.md`
- `CONTEXT.md`
- relevant decisions under `docs/adr/`
- relevant operator or engineering guidance under `docs/agents/`

# EXPLORATION

Explore enough of the repository to give an evidence-backed assessment. Cover
only sections where you have useful findings:

- **Assessment:** whether the issue's claims hold up against the current code.
- **Difficulty:** how hard the change appears and why.
- **Relevant files:** where implementation would most likely land and what each
  area contributes.
- **Open questions:** decisions or unknowns an implementer must resolve.
- **Possible approach:** a concise implementation outline, including the most
  valuable test seams.

You may read any file and run read-only checks, focused tests, typechecking,
`git log`, or `git blame` to ground the assessment.

You must not edit files, commit, push, change labels, create or edit issues/PRs,
or post comments. The workflow publishes your extracted assessment.

When the investigation is complete, summarize your findings in prose. A resumed
extraction pass will serialize them for the workflow.
