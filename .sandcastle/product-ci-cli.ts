import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  inspectProductCi,
  publishProductCiCandidate,
  requestProductCiRerun,
  waitForProductCi,
  type RecoveryState,
} from "./product-ci";
import { GhProductCiGitHub } from "./product-ci-github";
import { requireEnv } from "./require-env";

const stateSchema = z.object({
  actions: z.array(z.enum(["repair-push", "rerun"])).max(2),
  branch: z.string().min(1).optional(),
  publishedHeadSha: z.string().min(1).optional(),
  pendingAction: z.enum(["repair-push", "rerun"]).optional(),
});
const execFileAsync = promisify(execFile);

const [command, ...args] = process.argv.slice(2);
const repository = requireEnv("GH_REPO");
const github = new GhProductCiGitHub({ repository });
const statePath = path.join(
  process.env.OUTPUT_DIR ?? process.env.RUNNER_TEMP ?? ".",
  "product-ci-recovery.json",
);

switch (command) {
  case "inspect":
  case "final-gate": {
    const verdict = await inspectProductCi({ github, prNumber: numberArg("--pr") });
    reportVerdict(verdict, optionalArg("--expected-head-file"));
    break;
  }
  case "wait": {
    const verdict = await waitForProductCi({
      github,
      prNumber: numberArg("--pr"),
      timeoutMs: (await waitTimeoutSeconds()) * 1_000,
      pollIntervalMs: numberArg("--poll-seconds", 30) * 1_000,
    });
    reportVerdict(verdict);
    break;
  }
  case "push": {
    const expectedBranch = requireEnv("BRANCH");
    const branch = await currentBranchName();
    const result = await publishProductCiCandidate({
      branch,
      expectedBranch,
      headSha: await currentHeadSha(),
      state: readState(),
      persistState: writeState,
      push: pushBranch,
    });
    if (!result.ok) fail(result.error);
    writeState(result.state);
    console.log(
      `Published candidate (${result.state.actions.length}/2 recovery actions).`,
    );
    break;
  }
  case "rerun": {
    const result = await requestProductCiRerun({
      github,
      prNumber: numberArg("--pr"),
      runId: numberArg("--run"),
      state: readState(),
      persistState: writeState,
    });
    if (!result.ok) fail(result.error);
    writeState(result.state);
    console.log(
      `Accepted Product CI rerun (${result.state.actions.length}/2 actions).`,
    );
    break;
  }
  default:
    fail(
      "Usage: product-ci-cli.ts inspect|wait|final-gate --pr N; " +
        "rerun --pr N --run ID; or push (with BRANCH set)",
    );
}

function numberArg(name: string, fallback?: number) {
  const index = args.indexOf(name);
  const raw = index === -1 ? undefined : args[index + 1];
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalArg(name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function waitTimeoutSeconds() {
  const explicit = optionalArg("--timeout-seconds");
  let requested: number | undefined;
  if (explicit !== undefined) {
    const value = Number(explicit);
    if (!Number.isInteger(value) || value <= 0) {
      fail("--timeout-seconds must be a positive integer.");
    }
    requested = value;
  }

  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return requested ?? 5_400;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", [
      "api",
      `repos/${repository}/actions/runs/${runId}`,
      "--jq",
      ".run_started_at",
    ]));
  } catch (error: unknown) {
    fail(
      `The workflow start time could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const startedAt = Date.parse(stdout.trim());
  if (!Number.isFinite(startedAt)) {
    fail(
      "The workflow start time is unreadable; refusing an unbounded Product CI wait.",
    );
  }

  const workflowTimeoutMs = 120 * 60 * 1_000;
  const blockedReportingReserveMs = 5 * 60 * 1_000;
  const remainingMs =
    startedAt + workflowTimeoutMs - blockedReportingReserveMs - Date.now();
  const seconds = Math.floor(remainingMs / 1_000);
  if (seconds <= 0) {
    fail("The workflow has no Product CI wait budget remaining.");
  }
  const timeoutSeconds = Math.min(requested ?? seconds, seconds);
  console.log(`Product CI wait budget: ${timeoutSeconds} seconds remaining.`);
  return timeoutSeconds;
}

function readState(): RecoveryState {
  if (!fs.existsSync(statePath)) return { actions: [] };
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    fail("Product CI recovery state is malformed; refusing to reset the budget.");
  }
  const parsed = stateSchema.safeParse(json);
  if (!parsed.success) {
    fail("Product CI recovery state is malformed; refusing to reset the budget.");
  }
  return parsed.data;
}

function writeState(state: RecoveryState) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function reportVerdict(
  verdict: Awaited<ReturnType<typeof inspectProductCi>>,
  expectedHeadFile?: string,
) {
  if (verdict.ok) {
    if (expectedHeadFile) {
      const expected = fs.readFileSync(expectedHeadFile, "utf8").trim();
      if (verdict.proof.headSha !== expected) {
        fail(
          `PR head ${verdict.proof.headSha} does not match the output-bound head ${expected}.`,
        );
      }
    }
    console.log(
      `Product CI passed for PR #${verdict.proof.prNumber} at ` +
        `${verdict.proof.headSha}/${verdict.proof.baseSha} (${verdict.proof.runUrl}).`,
    );
    return;
  }
  fail(`${verdict.error}\n${verdict.diagnostics}`);
}

async function currentHeadSha() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function currentBranchName() {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"]);
  const branch = stdout.trim();
  if (!branch) fail("Candidate publication requires a checked-out branch.");
  return branch;
}

async function pushBranch(branch: string) {
  await execFileAsync(
    "git",
    ["push", "origin", `HEAD:refs/heads/${branch}`],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

function fail(message: string): never {
  console.error(message);
  const outputDir = process.env.OUTPUT_DIR ?? process.env.RUNNER_TEMP;
  if (outputDir) {
    fs.writeFileSync(path.join(outputDir, "failure_reason.txt"), message);
  }
  process.exit(1);
}
