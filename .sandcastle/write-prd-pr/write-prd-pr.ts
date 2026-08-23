import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { z } from "zod";
import { loadPrdPrContext } from "../capability-context";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { logResolvedAgent } from "../resolve-agent";
import { runWithRetry } from "../run-with-retry";

/**
 * The `write-prd-pr` capability: author the title and body for the draft PR that
 * delivers a whole PRD.
 *
 * Invoked by `.github/workflows/agent-implement-prd.yml` on the FIRST sub-issue
 * run only (the workflow reuses the same PR across every later run). So the body
 * must describe the PRD as a whole, not the one sub-issue that happened to open
 * it. The agent only reads the PRD and its sub-issues and summarises them — it
 * implements nothing and commits nothing. Because the structured output IS the
 * work, this uses {@link runWithRetry}: a single combined prompt drafts and
 * emits, retrying the same session on a malformed or non-conforming `<output>`.
 *
 * The title/body are written to `outputDir` as flat text files for the
 * workflow's `gh pr create --body-file`, keeping every git/gh mutation in the
 * workflow. Provider and coordinates come from the shared PRD seam.
 */

const ctx = loadPrdPrContext("write-prd-pr");
logResolvedAgent(ctx);

// Same subscription-seat setup as implement-prd — this phase also runs the
// agent, so it must authenticate identically (a no-op when the run resolved to
// Claude).
prepareCodexAuth(ctx.agent.name);

// `prTitle` is capped at GitHub's 256-char PR-title limit. `prDescription` must
// contain `Closes #<PRD>` so merging the PR closes the PRD — enforced here, not
// just in the prompt, so a compliant-looking-but-wrong body triggers a retry
// rather than opening a PR that leaves the PRD open. (Sub-issues are closed by
// the workflow per-run, so only the parent PRD is closed by the PR body.)
const PrdPrOutput = z
  .object({
    prTitle: z.string().min(1).max(256),
    prDescription: z.string().min(1),
  })
  .refine(
    (o) =>
      new RegExp(`closes\\s+#${ctx.prdNumber}\\b`, "i").test(o.prDescription),
    {
      path: ["prDescription"],
      message: `prDescription must contain "Closes #${ctx.prdNumber}" so the PR closes the PRD on merge`,
    },
  );

const result = await runWithRetry({
  name: `write-prd-pr-#${ctx.prdNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: ctx.promptArgs,
  output: sandcastle.Output.object({ tag: "output", schema: PrdPrOutput }),
});

fs.writeFileSync(
  path.join(ctx.outputDir, "pr_title.txt"),
  result.output.prTitle,
);
fs.writeFileSync(
  path.join(ctx.outputDir, "pr_description.txt"),
  result.output.prDescription,
);

console.log(`\nWrote PRD PR metadata to ${ctx.outputDir}`);
console.log(`  title: ${result.output.prTitle}`);
