import { describe, expect, it } from "vitest";
import { GhProductCiGitHub } from "./product-ci-github";

describe("GitHub Product CI adapter", () => {
  it("maps pull request, run, and Product-job API responses", async () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const responses = [
      JSON.stringify({
        number: 42,
        state: "open",
        draft: true,
        head: { sha: headSha, ref: "agent/issue-42", repo: { full_name: "o/r" } },
        base: { sha: baseSha, ref: "dev", repo: { full_name: "o/r" } },
      }),
      JSON.stringify({
        workflow_runs: [{
          id: 100,
          run_attempt: 2,
          name: "CI",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.test/runs/100",
          created_at: "2026-08-19T00:00:00Z",
          pull_requests: [{ number: 42, head: { sha: headSha }, base: { sha: baseSha } }],
        }],
      }),
      JSON.stringify({ jobs: [{ id: 200, name: "Product", status: "completed", conclusion: "success", html_url: "https://github.test/jobs/200" }] }),
    ];
    const github = new GhProductCiGitHub({
      repository: "o/r",
      execute: async () => responses.shift() ?? "",
    });

    await expect(github.getPullRequest(42)).resolves.toMatchObject({
      headSha,
      baseSha,
      repository: "o/r",
    });
    await expect(github.listWorkflowRuns()).resolves.toEqual([
      expect.objectContaining({ id: 100, attempt: 2, workflowName: "CI" }),
    ]);
    await expect(github.listRunJobs(100)).resolves.toEqual([
      expect.objectContaining({ id: 200, name: "Product" }),
    ]);
  });

  it("rejects malformed GitHub data instead of guessing", async () => {
    const github = new GhProductCiGitHub({
      repository: "o/r",
      execute: async () => JSON.stringify({ number: 42, state: "open" }),
    });

    await expect(github.getPullRequest(42)).rejects.toThrow("Malformed GitHub");
  });

  it("rejects invalid run timestamps instead of accepting ambiguous ordering", async () => {
    const github = new GhProductCiGitHub({
      repository: "o/r",
      execute: async () => JSON.stringify({
        workflow_runs: [{
          id: 100,
          run_attempt: 1,
          name: "CI",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.test/runs/100",
          created_at: "not-a-timestamp",
          pull_requests: [],
        }],
      }),
    });

    await expect(github.listWorkflowRuns()).rejects.toThrow("Malformed GitHub");
  });

  it("reruns cancelled candidates as whole runs and failures as failed jobs", async () => {
    const requests: string[][] = [];
    const github = new GhProductCiGitHub({
      repository: "o/r",
      execute: async (args) => {
        requests.push([...args]);
        return "";
      },
    });

    await github.rerunJobs({ runId: 100, failedOnly: false });
    await github.rerunJobs({ runId: 101, failedOnly: true });

    expect(requests).toEqual([
      ["api", "--method", "POST", "repos/o/r/actions/runs/100/rerun"],
      [
        "api",
        "--method",
        "POST",
        "repos/o/r/actions/runs/101/rerun-failed-jobs",
      ],
    ]);
  });
});
