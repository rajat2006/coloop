import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { requireEnv } from "./require-env";

const execFileAsync = promisify(execFile);
const threadIdsSchema = z.array(z.string().min(1));
const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              id: z.string().min(1),
              isResolved: z.boolean(),
            }),
          ),
        }),
      }),
    }),
  }),
});
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "snapshot":
    console.log(JSON.stringify(await unresolvedThreadIds(numberArg("--pr"))));
    break;
  case "assert-current": {
    const expected = threadIdsSchema.parse(JSON.parse(stringArg("--expected")));
    const current = await unresolvedThreadIds(numberArg("--pr"));
    const expectedIds = [...new Set(expected)].sort();
    const currentIds = [...new Set(current)].sort();
    if (
      expectedIds.length !== expected.length ||
      currentIds.length !== current.length ||
      expectedIds.length !== currentIds.length ||
      expectedIds.some((id, index) => id !== currentIds[index])
    ) {
      fail(
        "The unresolved review-thread set changed after agent inspection; refusing stale publication.",
      );
    }
    break;
  }
  default:
    fail("Usage: review-threads-cli.ts snapshot|assert-current --pr N [--expected JSON]");
}

async function unresolvedThreadIds(prNumber: number) {
  const repository = requireEnv("GH_REPO");
  const [owner, name] = repository.split("/");
  if (!owner || !name) fail("GH_REPO must be an owner/name repository.");
  const query = `
    query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes { id isResolved }
          }
        }
      }
    }`;
  const { stdout } = await execFileAsync("gh", [
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `pr=${prNumber}`,
    "-f",
    `query=${query}`,
  ]);
  const threads = responseSchema.parse(JSON.parse(stdout)).data.repository
    .pullRequest.reviewThreads.nodes;
  return threadIdsSchema.parse(
    threads.filter((thread) => !thread.isResolved).map((thread) => thread.id),
  );
}

function numberArg(name: string) {
  const value = Number(stringArg(name));
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer.`);
  return value;
}

function stringArg(name: string) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) fail(`${name} is required.`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
