export interface ExploreRepositoryFacts {
  readonly initialHead: string;
  readonly finalHead: string;
  /** Output from `git status --porcelain`. */
  readonly porcelainStatus: string;
}

export type ExploreReadOnlyVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify the repository-level half of `agent:explore`'s read-only contract.
 * The workflow separately withholds GitHub credentials from the agent step;
 * this seam prevents a run that committed or edited local files from being
 * reported as a successful exploration.
 */
export function verifyExploreReadOnly(
  facts: ExploreRepositoryFacts,
): ExploreReadOnlyVerification {
  if (facts.finalHead !== facts.initialHead) {
    return {
      ok: false,
      reason: `Explore changed HEAD from ${facts.initialHead} to ${facts.finalHead}.`,
    };
  }

  const changes = facts.porcelainStatus.trim();
  if (changes.length > 0) {
    return {
      ok: false,
      reason:
        "Explore left repository changes despite its read-only contract: " +
        changes.split("\n").join("; "),
    };
  }

  return { ok: true };
}
