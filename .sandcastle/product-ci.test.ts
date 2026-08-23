import { describe, expect, it, vi } from "vitest";
import {
  inspectProductCi,
  publishProductCiCandidate,
  requestProductCiRerun,
  waitForProductCi,
  type ProductCiGitHub,
  type ProductCiJob,
  type ProductCiPullRequest,
  type ProductCiRun,
  type RecoveryState,
} from "./product-ci";

const persistState = async () => undefined;

const pullRequest: ProductCiPullRequest = {
  number: 42,
  state: "OPEN",
  draft: true,
  headSha: "head-current",
  baseSha: "base-current",
  headRef: "agent/issue-42-example",
  baseRef: "dev",
  headRepository: "example/coloop",
  repository: "example/coloop",
};

function run(
  overrides: Partial<ProductCiRun> = {},
): ProductCiRun {
  return {
    id: 100,
    attempt: 1,
    workflowName: "CI",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    url: "https://github.test/runs/100",
    createdAt: "2026-08-19T10:00:00Z",
    pullRequests: [
      { number: 42, headSha: "head-current", baseSha: "base-current" },
    ],
    ...overrides,
  };
}

function job(overrides: Partial<ProductCiJob> = {}): ProductCiJob {
  return {
    id: 200,
    name: "Product",
    status: "completed",
    conclusion: "success",
    url: "https://github.test/jobs/200",
    ...overrides,
  };
}

function advancingClock(step = 10) {
  let time = 0;
  return () => (time += step);
}

class FakeGitHub implements ProductCiGitHub {
  pullRequests: ProductCiPullRequest[] = [pullRequest];
  runs: ProductCiRun[] = [run()];
  jobs = new Map<number, ProductCiJob[]>([[100, [job()]]]);
  logs = new Map<number, string>();
  reruns: { runId: number; failedOnly: boolean }[] = [];
  pullRequestError?: Error;
  runsError?: Error;

  async getPullRequest() {
    if (this.pullRequestError) throw this.pullRequestError;
    return this.pullRequests.shift() ?? pullRequest;
  }

  async listWorkflowRuns() {
    if (this.runsError) throw this.runsError;
    return this.runs;
  }

  async listRunJobs(runId: number) {
    return this.jobs.get(runId) ?? [];
  }

  async getJobLog(jobId: number) {
    return this.logs.get(jobId) ?? "";
  }

  async rerunJobs(request: { runId: number; failedOnly: boolean }) {
    this.reruns.push(request);
  }
}

describe("Product CI evidence", () => {
  it("accepts the latest successful Product job for the live PR head and base", async () => {
    const verdict = await inspectProductCi({
      github: new FakeGitHub(),
      prNumber: 42,
    });

    expect(verdict).toEqual({
      ok: true,
      proof: {
        prNumber: 42,
        headSha: "head-current",
        baseSha: "base-current",
        runId: 100,
        runAttempt: 1,
        runUrl: "https://github.test/runs/100",
        jobUrl: "https://github.test/jobs/200",
      },
    });
  });

  it.each([
    ["pending", run({ status: "in_progress", conclusion: null }), job({ status: "in_progress", conclusion: null })],
    ["failed", run({ conclusion: "failure" }), job({ conclusion: "failure" })],
    ["cancelled", run({ conclusion: "cancelled" }), job({ conclusion: "cancelled" })],
  ] as const)("classifies a current %s run", async (status, currentRun, currentJob) => {
    const github = new FakeGitHub();
    github.runs = [currentRun];
    github.jobs.set(currentRun.id, [currentJob]);

    const verdict = await inspectProductCi({ github, prNumber: 42 });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.status).toBe(status);
  });

  it("treats a queued run whose Product job has not appeared yet as pending", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ status: "queued", conclusion: null })];
    github.jobs.set(100, []);

    await expect(
      inspectProductCi({ github, prNumber: 42 }),
    ).resolves.toMatchObject({ ok: false, status: "pending" });
  });

  it.each([
    ["stale head", run({ pullRequests: [{ number: 42, headSha: "old", baseSha: "base-current" }] })],
    ["stale base", run({ pullRequests: [{ number: 42, headSha: "head-current", baseSha: "old" }] })],
    ["wrong pull request", run({ pullRequests: [{ number: 99, headSha: "head-current", baseSha: "base-current" }] })],
    ["wrong workflow", run({ workflowName: "Release policy" })],
    ["wrong event", run({ event: "push" })],
  ] as const)("ignores %s evidence", async (_name, irrelevantRun) => {
    const github = new FakeGitHub();
    github.runs = [irrelevantRun];

    const verdict = await inspectProductCi({ github, prNumber: 42 });

    expect(verdict).toMatchObject({ ok: false, status: "missing" });
  });

  it("rejects a run without exactly one Product job", async () => {
    const github = new FakeGitHub();
    github.jobs.set(100, [job({ name: "Lint" })]);

    const verdict = await inspectProductCi({ github, prNumber: 42 });

    expect(verdict).toMatchObject({ ok: false, status: "malformed" });
  });

  it("uses the newest relevant run attempt instead of an older success", async () => {
    const github = new FakeGitHub();
    github.runs = [
      run(),
      run({
        id: 101,
        attempt: 2,
        conclusion: "failure",
        createdAt: "2026-08-19T10:05:00Z",
      }),
    ];
    github.jobs.set(101, [job({ id: 201, conclusion: "failure" })]);

    const verdict = await inspectProductCi({ github, prNumber: 42 });

    expect(verdict).toMatchObject({
      ok: false,
      status: "failed",
      run: { id: 101, attempt: 2 },
    });
  });

  it("fails closed on malformed responses and API errors", async () => {
    const malformed = new FakeGitHub();
    malformed.runs = [run({ pullRequests: [] })];
    const unreadable = new FakeGitHub();
    unreadable.runsError = new Error("GitHub unavailable");

    await expect(
      inspectProductCi({ github: malformed, prNumber: 42 }),
    ).resolves.toMatchObject({ ok: false, status: "missing" });
    await expect(
      inspectProductCi({ github: unreadable, prNumber: 42 }),
    ).resolves.toMatchObject({ ok: false, status: "unreadable" });
  });

  it("invalidates proof when the live head or base changes on final recheck", async () => {
    const github = new FakeGitHub();
    github.pullRequests = [
      pullRequest,
      { ...pullRequest, headSha: "concurrent-push" },
    ];

    const first = await inspectProductCi({ github, prNumber: 42 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await inspectProductCi({ github, prNumber: 42 });
    expect(second).toMatchObject({ ok: false, status: "missing" });
  });
});

describe("Product CI polling and diagnostics", () => {
  it("polls pending evidence with an injected sleeper and emits progress", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ status: "in_progress", conclusion: null })];
    github.jobs.set(100, [job({ status: "in_progress", conclusion: null })]);
    const sleep = vi.fn(async () => {
      github.runs = [run()];
      github.jobs.set(100, [job()]);
    });
    const progress = vi.fn();

    const verdict = await waitForProductCi({
      github,
      prNumber: 42,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      now: advancingClock(),
      sleep,
      progress,
    });

    expect(verdict.ok).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("pending"));
  });

  it("returns a bounded failed Product-job diagnostic", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ conclusion: "failure" })];
    github.jobs.set(100, [job({ conclusion: "failure" })]);
    github.logs.set(200, "x".repeat(20_000));

    const verdict = await inspectProductCi({ github, prNumber: 42 });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.diagnostics).toContain("https://github.test/runs/100");
      expect(verdict.diagnostics.length).toBeLessThanOrEqual(8_500);
    }
  });

  it("times out without waiting on real time", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ status: "in_progress", conclusion: null })];
    github.jobs.set(100, [job({ status: "in_progress", conclusion: null })]);

    const verdict = await waitForProductCi({
      github,
      prNumber: 42,
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: advancingClock(),
      sleep: async () => undefined,
      progress: () => undefined,
    });

    expect(verdict).toMatchObject({ ok: false, status: "timed-out" });
    if (!verdict.ok) {
      expect(verdict.diagnostics).toContain("https://github.test/runs/100");
    }
  });
});

describe("Product CI recovery budget", () => {
  it("persists a pending repair before mutation and blocks ambiguous retries", async () => {
    const persisted: RecoveryState[] = [];
    const result = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-head",
      state: {
        actions: [],
        branch: "agent/issue-42-example",
        publishedHeadSha: "initial-head",
      },
      persistState: async (state) => {
        persisted.push(state);
      },
      push: async () => {
        throw new Error("connection closed after send");
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(persisted).toEqual([
      {
        actions: [],
        branch: "agent/issue-42-example",
        publishedHeadSha: "initial-head",
        pendingAction: "repair-push",
      },
    ]);

    let pushed = false;
    const retry = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-head",
      state: persisted[0]!,
      persistState: async () => undefined,
      push: async () => {
        pushed = true;
      },
    });
    expect(retry).toMatchObject({
      ok: false,
      error: expect.stringContaining("pending"),
    });
    expect(pushed).toBe(false);
  });

  it("persists a pending rerun before asking GitHub to mutate the run", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ conclusion: "failure" })];
    github.jobs.set(100, [job({ conclusion: "failure" })]);
    const persisted: RecoveryState[] = [];

    const result = await requestProductCiRerun({
      github,
      prNumber: 42,
      runId: 100,
      state: { actions: [] },
      persistState: async (state) => {
        persisted.push(state);
      },
    });

    expect(persisted).toEqual([
      { actions: [], pendingAction: "rerun" },
    ]);
    expect(result).toEqual({
      ok: true,
      state: { actions: ["rerun"] },
    });
    expect(github.reruns).toEqual([{ runId: 100, failedOnly: true }]);
  });

  it("reruns the whole current run when Product CI was cancelled", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ conclusion: "cancelled" })];
    github.jobs.set(100, [job({ conclusion: "cancelled" })]);

    const result = await requestProductCiRerun({
      github,
      prNumber: 42,
      runId: 100,
      state: { actions: [] },
      persistState,
    });

    expect(result).toMatchObject({ ok: true });
    expect(github.reruns).toEqual([{ runId: 100, failedOnly: false }]);
  });

  it("counts successful repair pushes and accepted reruns but not initial publication", async () => {
    const pushes: string[] = [];
    const initial = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "initial-head",
      state: { actions: [] },
      persistState,
      push: async (branch) => pushes.push(branch),
    });
    expect(initial).toEqual({
      ok: true,
      state: {
        actions: [],
        branch: "agent/issue-42-example",
        publishedHeadSha: "initial-head",
      },
    });

    const github = new FakeGitHub();
    github.runs = [run({ conclusion: "failure" })];
    github.jobs.set(100, [job({ conclusion: "failure" })]);
    const repair = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-head",
      state: initial.ok ? initial.state : { actions: [] },
      persistState,
      push: async (branch) => pushes.push(branch),
    });
    expect(repair).toEqual({
      ok: true,
      state: {
        actions: ["repair-push"],
        branch: "agent/issue-42-example",
        publishedHeadSha: "repair-head",
      },
    });

    const rerun = await requestProductCiRerun({
      github,
      prNumber: 42,
      runId: 100,
      state: repair.ok ? repair.state : { actions: [] },
      persistState,
    });

    expect(rerun).toEqual({
      ok: true,
      state: {
        actions: ["repair-push", "rerun"],
        branch: "agent/issue-42-example",
        publishedHeadSha: "repair-head",
      },
    });
    expect(pushes).toEqual([
      "agent/issue-42-example",
      "agent/issue-42-example",
    ]);
    expect(github.reruns).toEqual([{ runId: 100, failedOnly: true }]);
  });

  it("does not consume a recovery action when a repair push fails", async () => {
    const result = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-head",
      state: {
        actions: [],
        branch: "agent/issue-42-example",
        publishedHeadSha: "initial-head",
      },
      persistState,
      push: async () => {
        throw new Error("non-fast-forward");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Candidate push failed: non-fast-forward",
    });
  });

  it("derives repair status from the published head instead of trusting a caller", async () => {
    const firstRepair = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-one",
      state: {
        actions: [],
        branch: "agent/issue-42-example",
        publishedHeadSha: "initial-head",
      },
      persistState,
      push: async () => undefined,
    });
    const secondRepair = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-two",
      state: firstRepair.ok ? firstRepair.state : { actions: [] },
      persistState,
      push: async () => undefined,
    });

    expect(secondRepair).toMatchObject({
      ok: true,
      state: { actions: ["repair-push", "repair-push"] },
    });
  });

  it("refuses to publish to a branch other than the automation branch", async () => {
    let pushed = false;
    const result = await publishProductCiCandidate({
      branch: "agent/issue-99-other",
      expectedBranch: "agent/issue-42-example",
      headSha: "head",
      state: { actions: [] },
      persistState,
      push: async () => {
        pushed = true;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("automation branch"),
    });
    expect(pushed).toBe(false);
  });

  it("refuses a third repair push before mutating the branch", async () => {
    let pushed = false;
    const result = await publishProductCiCandidate({
      branch: "agent/issue-42-example",
      expectedBranch: "agent/issue-42-example",
      headSha: "repair-three",
      state: {
        actions: ["repair-push", "rerun"],
        branch: "agent/issue-42-example",
        publishedHeadSha: "repair-two",
      },
      persistState,
      push: async () => {
        pushed = true;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("two"),
    });
    expect(pushed).toBe(false);
  });

  it("refuses a third recovery mutation", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ conclusion: "failure" })];
    github.jobs.set(100, [job({ conclusion: "failure" })]);

    const result = await requestProductCiRerun({
      github,
      prNumber: 42,
      runId: 100,
      state: { actions: ["repair-push", "rerun"] },
      persistState,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("two") });
    expect(github.reruns).toEqual([]);
  });

  it("refuses to rerun a stale candidate", async () => {
    const github = new FakeGitHub();
    github.runs = [run({ conclusion: "failure" })];
    github.jobs.set(100, [job({ conclusion: "failure" })]);
    github.pullRequests = [{ ...pullRequest, baseSha: "new-base" }];

    const result = await requestProductCiRerun({
      github,
      prNumber: 42,
      runId: 100,
      state: { actions: [] },
      persistState,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("current") });
    expect(github.reruns).toEqual([]);
  });
});
