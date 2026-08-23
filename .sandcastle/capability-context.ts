import { resolveAgent, type Capability, type ResolvedAgent } from "./resolve-agent";
import { requireEnv } from "./require-env";

/**
 * Context for a read-only capability attached to an issue, such as
 * `agent:explore`. It intentionally has no branch: the capability investigates
 * the repository's default branch and emits output for the workflow to publish
 * without committing.
 */
export interface IssueCapabilityContext extends ResolvedAgent {
  readonly issueNumber: string;
  readonly issueTitle: string;
  readonly baseBranch: string;
  readonly outputDir: string;
  /** The issue's full label set, including the optional provider label. */
  readonly labels: readonly string[];
  readonly promptArgs: {
    readonly ISSUE_NUMBER: string;
    readonly ISSUE_TITLE: string;
    readonly BASE_BRANCH: string;
  };
}

/**
 * Assemble a branchless, issue-shaped capability context from `process.env`.
 * Required vars throw via {@link requireEnv}; the `AGENT_LABELS` set chooses the
 * provider and the caller's `capability` chooses that provider's model + effort,
 * just like every branch-mutating capability.
 */
export function loadIssueCapabilityContext(
  capability: Capability,
): IssueCapabilityContext {
  const issueNumber = requireEnv("ISSUE_NUMBER");
  const issueTitle = requireEnv("ISSUE_TITLE");
  const baseBranch = requireEnv("BASE_BRANCH");
  const outputDir = requireEnv("OUTPUT_DIR");
  const labels = JSON.parse(process.env.AGENT_LABELS ?? "[]") as string[];

  return {
    issueNumber,
    issueTitle,
    baseBranch,
    outputDir,
    labels,
    ...resolveAgent(labels, capability),
    promptArgs: {
      ISSUE_NUMBER: issueNumber,
      ISSUE_TITLE: issueTitle,
      BASE_BRANCH: baseBranch,
    },
  };
}

/**
 * Everything a capability run() script needs from the workflow-supplied
 * environment — the issue coordinates, the output directory, and the provider
 * resolved from the issue's label set — assembled once. Extends
 * {@link ResolvedAgent} so `agent`/`model` sit alongside the rest.
 */
export interface CapabilityContext extends ResolvedAgent {
  readonly issueNumber: string;
  readonly issueTitle: string;
  readonly branch: string;
  readonly baseBranch: string;
  /** Directory the workflow reads output files back from (`runner.temp`). */
  readonly outputDir: string;
  /** The issue's full label set. */
  readonly labels: readonly string[];
  /** Ready to spread into `run()`'s `promptArgs` for `{{ISSUE_NUMBER}}` etc. */
  readonly promptArgs: {
    readonly ISSUE_NUMBER: string;
    readonly ISSUE_TITLE: string;
    readonly BRANCH: string;
    readonly BASE_BRANCH: string;
  };
}

/**
 * Assemble the {@link CapabilityContext} from `process.env`. Every `agent-*.yml`
 * workflow sets the same env contract before invoking a capability script, so
 * this is the one place that reads it.
 *
 * The provider is resolved from the issue's FULL label set (`AGENT_LABELS`, a
 * JSON array), not just the just-added trigger label — that is what lets a
 * provider label (`agent:claude` / `agent:codex`) be applied independently of
 * `agent:implement`. With neither present the default provider applies.
 * The `capability` the caller passes chooses that provider's model + effort.
 *
 * Required vars (`ISSUE_NUMBER`, `ISSUE_TITLE`, `BRANCH`, `BASE_BRANCH`,
 * `OUTPUT_DIR`) throw via {@link requireEnv} when missing — a missing one is a
 * workflow wiring bug that should land the issue in `agent:blocked`, not run
 * against a silent default.
 */
export function loadCapabilityContext(
  capability: Capability,
): CapabilityContext {
  const issue = loadIssueCapabilityContext(capability);
  const branch = requireEnv("BRANCH");

  return {
    ...issue,
    branch,
    promptArgs: {
      ISSUE_NUMBER: issue.issueNumber,
      ISSUE_TITLE: issue.issueTitle,
      BRANCH: branch,
      BASE_BRANCH: issue.baseBranch,
    },
  };
}

/**
 * The env contract shared by the PRD-mode capabilities. Both read the PRD
 * coordinates, the output dir, and the provider resolved from the PRD's full
 * label set; {@link PrdImplementContext} extends it with the one sub-issue being
 * worked. Kept in this module so PRD scripts route through the same seam as the
 * single-issue capabilities rather than each re-parsing `process.env`.
 */
export interface PrdPrContext extends ResolvedAgent {
  readonly prdNumber: string;
  readonly prdTitle: string;
  readonly baseBranch: string;
  /** Directory the workflow reads output files back from (`runner.temp`). */
  readonly outputDir: string;
  /** The PRD's full label set. */
  readonly labels: readonly string[];
  readonly promptArgs: {
    readonly PRD_NUMBER: string;
    readonly PRD_TITLE: string;
    readonly BASE_BRANCH: string;
  };
}

/**
 * Everything the `implement-prd` capability needs: the PRD coordinates plus the
 * single sub-issue this run works (the PRD workflow advances one sub-issue per
 * run), all on the resumed accumulating branch.
 */
export interface PrdImplementContext extends PrdPrContext {
  readonly subIssueNumber: string;
  readonly subIssueTitle: string;
  readonly branch: string;
  readonly promptArgs: {
    readonly PRD_NUMBER: string;
    readonly PRD_TITLE: string;
    readonly SUB_ISSUE_NUMBER: string;
    readonly SUB_ISSUE_TITLE: string;
    readonly BRANCH: string;
    readonly BASE_BRANCH: string;
  };
}

/**
 * Assemble the {@link PrdPrContext} for the PRD-shaped capabilities
 * (`write-prd-pr`, `to-issues`) from `process.env`. Reads only the PRD
 * coordinates (the body describes the whole PRD, not a single sub-issue) and
 * resolves the provider from the PRD's full label set; the caller's `capability`
 * chooses that provider's model + effort. Required vars throw via
 * {@link requireEnv}.
 */
export function loadPrdPrContext(capability: Capability): PrdPrContext {
  const prdNumber = requireEnv("PRD_NUMBER");
  const prdTitle = requireEnv("PRD_TITLE");
  const baseBranch = requireEnv("BASE_BRANCH");
  const outputDir = requireEnv("OUTPUT_DIR");
  const labels = JSON.parse(process.env.AGENT_LABELS ?? "[]") as string[];

  return {
    prdNumber,
    prdTitle,
    baseBranch,
    outputDir,
    labels,
    ...resolveAgent(labels, capability),
    promptArgs: {
      PRD_NUMBER: prdNumber,
      PRD_TITLE: prdTitle,
      BASE_BRANCH: baseBranch,
    },
  };
}

/**
 * Assemble the {@link PrdImplementContext} for `implement-prd` from
 * `process.env` — the PRD coordinates plus the single sub-issue this run works
 * (`SUB_ISSUE_NUMBER`/`SUB_ISSUE_TITLE`) and the accumulating `BRANCH`. Provider
 * is resolved from the PRD's full label set, the same seam every other capability
 * uses; the caller's `capability` chooses that provider's model + effort.
 * Required vars throw via {@link requireEnv}.
 */
export function loadPrdImplementContext(
  capability: Capability,
): PrdImplementContext {
  const prdNumber = requireEnv("PRD_NUMBER");
  const prdTitle = requireEnv("PRD_TITLE");
  const subIssueNumber = requireEnv("SUB_ISSUE_NUMBER");
  const subIssueTitle = requireEnv("SUB_ISSUE_TITLE");
  const branch = requireEnv("BRANCH");
  const baseBranch = requireEnv("BASE_BRANCH");
  const outputDir = requireEnv("OUTPUT_DIR");
  const labels = JSON.parse(process.env.AGENT_LABELS ?? "[]") as string[];

  return {
    prdNumber,
    prdTitle,
    subIssueNumber,
    subIssueTitle,
    branch,
    baseBranch,
    outputDir,
    labels,
    ...resolveAgent(labels, capability),
    promptArgs: {
      PRD_NUMBER: prdNumber,
      PRD_TITLE: prdTitle,
      SUB_ISSUE_NUMBER: subIssueNumber,
      SUB_ISSUE_TITLE: subIssueTitle,
      BRANCH: branch,
      BASE_BRANCH: baseBranch,
    },
  };
}
