# Code comments

Write comments for the next person changing the code.

This applies to human-maintained source, tests, scripts, workflows, and
configuration. License headers, TODOs, tool directives, generated markers,
Markdown, and public API documentation follow their own conventions.

Add a comment when the code hides an important reason, constraint, or risk that
would be hard to recover. Typical examples are ordering requirements, security
boundaries, concurrency hazards, lifecycle rules, and external-system quirks.

Before adding one:

1. Verify the claim in code, tests, documentation, or relevant history.
2. Prefer a clearer name, type, interface, or small extraction when that explains
   the same thing.
3. Put the comment beside the smallest piece of code that owns the constraint.

## Writing the comment

- Explain why the code must work this way or what breaks if it changes.
- Use plain, direct language and the project's domain terms.
- Keep it to one idea and only as much context as that idea needs.
- Point to an ADR or other source when broader context matters; do not copy it.

Skip comments that narrate the code, repeat names or types, preserve temporary
history, speculate, or describe behavior already made clear by tests or public
API documentation.

## Keeping comments accurate

When behavior changes, reread every comment whose claim may have changed.
Update, move, or delete it in the same change. Recheck the whole comment, not
just the line nearest the edit. Leave unrelated comments alone.

If an existing comment in the changed area cannot be verified or disproved:

- Stop if the change relies on it or could violate it.
- Otherwise prefix it with `UNVERIFIED:` and report it as unresolved.
- Never use `UNVERIFIED:` for a new claim.

## Review

Raise a finding only when a missing, stale, or misleading comment creates a real
maintenance or correctness risk. State the hidden fact, the evidence, and where
the comment belongs. Do not optimize for comment count, density, or style.

Comment-only changes do not need new tests unless they expose an untested
behavioral contract. Verify the prose against its source instead.
