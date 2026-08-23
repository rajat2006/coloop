const PRODUCT_WORKFLOW = "CI";
const PRODUCT_JOB = "Product";
const MAX_DIAGNOSTIC_CHARACTERS = 8_000;
export const MAX_RECOVERY_ACTIONS = 2;
export const PRODUCT_CI_STATUSES = [
  "requested",
  "waiting",
  "queued",
  "pending",
  "in_progress",
  "completed",
] as const;
export const PRODUCT_CI_CONCLUSIONS = [
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
] as const;
export type ProductCiStatus = (typeof PRODUCT_CI_STATUSES)[number];
export type ProductCiConclusion = (typeof PRODUCT_CI_CONCLUSIONS)[number] | null;

export interface ProductCiCandidate {
  readonly headSha: string;
  readonly baseSha: string;
}

export interface ProductCiPullRequest extends ProductCiCandidate {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly draft: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headRepository: string;
  readonly repository: string;
}

export interface ProductCiRunPullRequest extends ProductCiCandidate {
  readonly number: number;
}

export interface ProductCiRun {
  readonly id: number;
  readonly attempt: number;
  readonly workflowName: string;
  readonly event: string;
  readonly status: ProductCiStatus;
  readonly conclusion: ProductCiConclusion;
  readonly url: string;
  readonly createdAt: string;
  readonly pullRequests: readonly ProductCiRunPullRequest[];
}

export interface ProductCiJob {
  readonly id: number;
  readonly name: string;
  readonly status: ProductCiStatus;
  readonly conclusion: ProductCiConclusion;
  readonly url: string;
}

/** The true-external GitHub boundary. Tests use a deterministic fake. */
export interface ProductCiGitHub {
  getPullRequest(prNumber: number): Promise<ProductCiPullRequest>;
  listWorkflowRuns(): Promise<readonly ProductCiRun[]>;
  listRunJobs(runId: number): Promise<readonly ProductCiJob[]>;
  getJobLog(jobId: number): Promise<string>;
  rerunJobs({
    runId,
    failedOnly,
  }: {
    runId: number;
    failedOnly: boolean;
  }): Promise<void>;
}

export interface ProductCiProof extends ProductCiCandidate {
  readonly prNumber: number;
  readonly runId: number;
  readonly runAttempt: number;
  readonly runUrl: string;
  readonly jobUrl: string;
}

export type ProductCiFailureStatus =
  | "missing"
  | "pending"
  | "failed"
  | "cancelled"
  | "malformed"
  | "unreadable"
  | "timed-out";

export type ProductCiVerdict =
  | { readonly ok: true; readonly proof: ProductCiProof }
  | {
      readonly ok: false;
      readonly status: ProductCiFailureStatus;
      readonly error: string;
      readonly run?: ProductCiRun;
      readonly diagnostics: string;
    };

export type RecoveryAction = "repair-push" | "rerun";

export interface RecoveryState {
  readonly actions: readonly RecoveryAction[];
  readonly branch?: string;
  readonly publishedHeadSha?: string;
  readonly pendingAction?: RecoveryAction;
}

export type RecoveryResult =
  | { readonly ok: true; readonly state: RecoveryState }
  | { readonly ok: false; readonly error: string };

export async function inspectProductCi({
  github,
  prNumber,
}: {
  github: ProductCiGitHub;
  prNumber: number;
}): Promise<ProductCiVerdict> {
  try {
    const pullRequest = await github.getPullRequest(prNumber);
    if (
      pullRequest.number !== prNumber ||
      pullRequest.state !== "OPEN" ||
      pullRequest.repository !== pullRequest.headRepository
    ) {
      return failure(
        "malformed",
        "The subject is not an open same-repository pull request.",
      );
    }

    const runs = await github.listWorkflowRuns();
    let current: ProductCiRun | undefined;
    for (const candidate of runs) {
      if (
        isCurrentRun({ candidate, pullRequest }) &&
        (!current || isNewerRun({ candidate, current }))
      ) {
        current = candidate;
      }
    }
    if (!current) {
      return failure(
        "missing",
        `No ${PRODUCT_WORKFLOW} pull-request run matches PR #${prNumber} at ` +
          `${pullRequest.headSha}/${pullRequest.baseSha}.`,
      );
    }

    const jobs = await github.listRunJobs(current.id);
    const productJobs = jobs.filter((candidate) => candidate.name === PRODUCT_JOB);
    if (current.status !== "completed" && productJobs.length === 0) {
      return failure(
        "pending",
        `Product CI run ${current.id} is waiting for its Product job.`,
        current,
      );
    }
    if (productJobs.length !== 1) {
      return failure(
        "malformed",
        `Run ${current.id} has ${productJobs.length} ${PRODUCT_JOB} jobs; expected exactly one.`,
        current,
      );
    }

    const productJob = productJobs[0];
    if (!productJob) {
      return failure("malformed", "Product job disappeared.", current);
    }
    if (current.status !== "completed" || productJob.status !== "completed") {
      return failure(
        "pending",
        `Product CI run ${current.id} is still pending.`,
        current,
      );
    }
    if (
      current.conclusion === "cancelled" ||
      productJob.conclusion === "cancelled"
    ) {
      return await failureWithDiagnostics({
        github,
        status: "cancelled",
        reason: `Product CI run ${current.id} was cancelled.`,
        run: current,
        job: productJob,
      });
    }
    if (
      current.conclusion !== "success" ||
      productJob.conclusion !== "success"
    ) {
      return await failureWithDiagnostics({
        github,
        status: "failed",
        reason: `Product CI run ${current.id} did not succeed.`,
        run: current,
        job: productJob,
      });
    }

    return {
      ok: true,
      proof: {
        prNumber,
        headSha: pullRequest.headSha,
        baseSha: pullRequest.baseSha,
        runId: current.id,
        runAttempt: current.attempt,
        runUrl: current.url,
        jobUrl: productJob.url,
      },
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      "unreadable",
      `Product CI evidence could not be read: ${detail}`,
    );
  }
}

export async function waitForProductCi({
  github,
  prNumber,
  timeoutMs,
  pollIntervalMs,
  now = Date.now,
  sleep = defaultSleep,
  progress = console.log,
}: {
  github: ProductCiGitHub;
  prNumber: number;
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  progress?: (message: string) => void;
}): Promise<ProductCiVerdict> {
  const deadline = now() + timeoutMs;
  let last: ProductCiVerdict;

  do {
    last = await inspectProductCi({ github, prNumber });
    if (last.ok || !["missing", "pending"].includes(last.status)) return last;
    progress(`Product CI ${last.status}; waiting for the current candidate…`);
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  } while (true);

  return failure(
    "timed-out",
    `Timed out waiting for Product CI on PR #${prNumber}. Last state: ${last.error}`,
    last.ok ? undefined : last.run,
  );
}

export function recordRecoveryAction({
  state,
  action,
}: {
  state: RecoveryState;
  action: RecoveryAction;
}): RecoveryResult {
  if (state.pendingAction) {
    return {
      ok: false,
      error: `A ${state.pendingAction} recovery mutation is still pending; refusing another action.`,
    };
  }
  if (state.actions.length >= MAX_RECOVERY_ACTIONS) {
    return {
      ok: false,
      error: "The two permitted Product CI recovery actions are already exhausted.",
    };
  }
  return {
    ok: true,
    state: { ...state, actions: [...state.actions, action] },
  };
}

export async function publishProductCiCandidate({
  branch,
  expectedBranch,
  headSha,
  state,
  persistState,
  push,
}: {
  branch: string;
  expectedBranch: string;
  headSha: string;
  state: RecoveryState;
  persistState: (state: RecoveryState) => void | Promise<void>;
  push: (branch: string) => Promise<unknown>;
}): Promise<RecoveryResult> {
  if (branch !== expectedBranch || (state.branch && state.branch !== branch)) {
    return {
      ok: false,
      error: "Candidate pushes are restricted to the current automation branch.",
    };
  }

  const isRepair =
    state.publishedHeadSha !== undefined && state.publishedHeadSha !== headSha;
  const accounted = isRepair
    ? recordRecoveryAction({ state, action: "repair-push" })
    : { ok: true as const, state };
  if (!accounted.ok) return accounted;

  if (isRepair) {
    try {
      await persistState({ ...state, pendingAction: "repair-push" });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Recovery reservation could not be persisted: ${detail}`,
      };
    }
  }

  try {
    await push(branch);
    return {
      ok: true,
      state: {
        ...accounted.state,
        branch,
        publishedHeadSha: headSha,
      },
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Candidate push failed: ${detail}` };
  }
}

export async function requestProductCiRerun({
  github,
  prNumber,
  runId,
  state,
  persistState,
}: {
  github: ProductCiGitHub;
  prNumber: number;
  runId: number;
  state: RecoveryState;
  persistState: (state: RecoveryState) => void | Promise<void>;
}): Promise<RecoveryResult> {
  const accounted = recordRecoveryAction({ state, action: "rerun" });
  if (!accounted.ok) return accounted;

  const verdict = await inspectProductCi({ github, prNumber });
  if (
    verdict.ok ||
    verdict.run?.id !== runId ||
    !["failed", "cancelled"].includes(verdict.status)
  ) {
    return {
      ok: false,
      error:
        "The requested run is not the current failed Product CI candidate; refusing to rerun stale evidence.",
    };
  }

  try {
    await persistState({ ...state, pendingAction: "rerun" });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Recovery reservation could not be persisted: ${detail}`,
    };
  }

  try {
    await github.rerunJobs({
      runId,
      failedOnly: verdict.status === "failed",
    });
    return accounted;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `GitHub rejected the Product CI rerun: ${detail}` };
  }
}

function isCurrentRun({
  candidate,
  pullRequest,
}: {
  candidate: ProductCiRun;
  pullRequest: ProductCiPullRequest;
}) {
  if (
    candidate.workflowName !== PRODUCT_WORKFLOW ||
    candidate.event !== "pull_request"
  ) {
    return false;
  }
  return candidate.pullRequests.some(
    (subject) =>
      subject.number === pullRequest.number &&
      subject.headSha === pullRequest.headSha &&
      subject.baseSha === pullRequest.baseSha,
  );
}

function isNewerRun({
  candidate,
  current,
}: {
  candidate: ProductCiRun;
  current: ProductCiRun;
}) {
  const candidateCreatedAt = Date.parse(candidate.createdAt);
  const currentCreatedAt = Date.parse(current.createdAt);
  if (candidateCreatedAt !== currentCreatedAt) {
    return candidateCreatedAt > currentCreatedAt;
  }
  if (candidate.attempt !== current.attempt) {
    return candidate.attempt > current.attempt;
  }
  return candidate.id > current.id;
}

async function failureWithDiagnostics({
  github,
  status,
  reason,
  run,
  job,
}: {
  github: ProductCiGitHub;
  status: "failed" | "cancelled";
  reason: string;
  run: ProductCiRun;
  job: ProductCiJob;
}): Promise<ProductCiVerdict> {
  let log = "";
  try {
    log = await github.getJobLog(job.id);
  } catch (error: unknown) {
    log = `(Product job log unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
  const diagnostics = [
    reason,
    `Run: ${run.url}`,
    `Product job: ${job.url}`,
    log.slice(-MAX_DIAGNOSTIC_CHARACTERS),
  ]
    .filter(Boolean)
    .join("\n");
  return { ok: false, status, error: reason, run, diagnostics };
}

function failure(
  status: ProductCiFailureStatus,
  reason: string,
  run?: ProductCiRun,
): ProductCiVerdict {
  return {
    ok: false,
    status,
    error: reason,
    run,
    diagnostics: [reason, run ? `Run: ${run.url}` : ""].filter(Boolean).join("\n"),
  };
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
