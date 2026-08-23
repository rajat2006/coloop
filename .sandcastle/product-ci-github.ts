import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ProductCiGitHub,
  ProductCiJob,
  ProductCiPullRequest,
  ProductCiRun,
} from "./product-ci";
import { PRODUCT_CI_CONCLUSIONS, PRODUCT_CI_STATUSES } from "./product-ci";

const execFileAsync = promisify(execFile);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const statusSchema = z.enum(PRODUCT_CI_STATUSES);
const conclusionSchema = z.enum(PRODUCT_CI_CONCLUSIONS).nullable();

export type GhExecutor = (args: readonly string[]) => Promise<string>;

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  draft: z.boolean(),
  head: z.object({
    sha: shaSchema,
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string().min(1) }),
  }),
  base: z.object({
    sha: shaSchema,
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string().min(1) }),
  }),
});

const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  name: z.literal("CI"),
  event: z.literal("pull_request"),
  status: statusSchema,
  conclusion: conclusionSchema,
  html_url: z.url(),
  created_at: z.iso.datetime(),
  pull_requests: z.array(
    z.object({
      number: z.number().int().positive(),
      head: z.object({ sha: shaSchema }),
      base: z.object({ sha: shaSchema }),
    }),
  ),
});

const runsSchema = z.object({ workflow_runs: z.array(runSchema) });

const jobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  status: statusSchema,
  conclusion: conclusionSchema,
  html_url: z.url(),
});

const jobsSchema = z.object({ jobs: z.array(jobSchema) });

export class GhProductCiGitHub implements ProductCiGitHub {
  readonly #repository: string;
  readonly #execute: GhExecutor;

  constructor({
    repository,
    execute = executeGh,
  }: {
    repository: string;
    execute?: GhExecutor;
  }) {
    this.#repository = repository;
    this.#execute = execute;
  }

  async getPullRequest(prNumber: number): Promise<ProductCiPullRequest> {
    const data = parseGitHub(
      pullRequestSchema,
      await this.#execute(["api", `repos/${this.#repository}/pulls/${prNumber}`]),
    );
    return {
      number: data.number,
      state: data.merged ? "MERGED" : data.state === "open" ? "OPEN" : "CLOSED",
      draft: data.draft,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      headRef: data.head.ref,
      baseRef: data.base.ref,
      headRepository: data.head.repo.full_name,
      repository: data.base.repo.full_name,
    };
  }

  async listWorkflowRuns(): Promise<readonly ProductCiRun[]> {
    const data = parseGitHub(
      runsSchema,
      await this.#execute([
        "api",
        `repos/${this.#repository}/actions/workflows/ci.yml/runs?event=pull_request&per_page=100`,
      ]),
    );
    return data.workflow_runs.map((candidate) => ({
      id: candidate.id,
      attempt: candidate.run_attempt,
      workflowName: candidate.name,
      event: candidate.event,
      status: candidate.status,
      conclusion: candidate.conclusion,
      url: candidate.html_url,
      createdAt: candidate.created_at,
      pullRequests: candidate.pull_requests.map((subject) => ({
        number: subject.number,
        headSha: subject.head.sha,
        baseSha: subject.base.sha,
      })),
    }));
  }

  async listRunJobs(runId: number): Promise<readonly ProductCiJob[]> {
    const data = parseGitHub(
      jobsSchema,
      await this.#execute([
        "api",
        `repos/${this.#repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      ]),
    );
    return data.jobs.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      status: candidate.status,
      conclusion: candidate.conclusion,
      url: candidate.html_url,
    }));
  }

  getJobLog(jobId: number) {
    return this.#execute([
      "api",
      `repos/${this.#repository}/actions/jobs/${jobId}/logs`,
    ]);
  }

  async rerunJobs({
    runId,
    failedOnly,
  }: {
    runId: number;
    failedOnly: boolean;
  }) {
    await this.#execute([
      "api",
      "--method",
      "POST",
      `repos/${this.#repository}/actions/runs/${runId}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`,
    ]);
  }
}

function parseGitHub<T>(schema: z.ZodType<T>, raw: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Malformed GitHub response: expected JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Malformed GitHub response: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function executeGh(args: readonly string[]) {
  const { stdout } = await execFileAsync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
