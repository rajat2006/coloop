/**
 * Read a required environment variable, throwing a clear error if it is unset or
 * empty.
 *
 * The capability run() scripts are launched by the workflow with a fixed set of
 * env vars (`ISSUE_NUMBER`, `BRANCH`, the provider token, …). A missing one is a
 * wiring bug in the workflow, not something the agent can recover from, so we
 * fail fast. Throwing (rather than `process.exit`) keeps this pure and
 * unit-testable while still aborting the `tsx` process with a non-zero code — the
 * workflow's `failure()` branch then marks the issue `agent:blocked`.
 *
 * `env` defaults to `process.env`; callers holding their own env object (e.g.
 * {@link file://./prepare-codex-auth.ts}) pass it so the check runs against the
 * same env they mutate, without a second copy of this validation.
 */
export function requireEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
