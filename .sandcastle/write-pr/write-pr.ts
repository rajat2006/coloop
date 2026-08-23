import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { z } from "zod";
import { loadCapabilityContext } from "../capability-context";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { logResolvedAgent } from "../resolve-agent";
import { runWithRetry } from "../run-with-retry";

/**
 * The `write-pr` capability: author the title and body for the draft PR.
 *
 * Invoked by `.github/workflows/agent-implement.yml` AFTER the branch is pushed,
 * so the agent only *reads* the issue and the branch diff and *summarises* them
 * — it implements nothing and commits nothing. Because the structured output IS
 * the work, this uses {@link runWithRetry} (not the two-phase extraction
 * wrapper): a single combined prompt drafts and emits, retrying the same session
 * on a malformed or non-conforming `<output>` block.
 *
 * The title/body are written to `outputDir` as flat text files for the
 * workflow's `gh pr create --body-file` step, keeping every git/gh mutation in
 * the workflow.
 */

const ctx = loadCapabilityContext("write-pr");
logResolvedAgent(ctx);

// Same subscription-seat setup as implement — this phase also runs the agent, so
// it must authenticate identically (a no-op when the run resolved to Claude Code).
prepareCodexAuth(ctx.agent.name);

// `prTitle` is capped at GitHub's 256-char PR-title limit. `prDescription` must
// contain `Closes #<issue>` so the PR closes the issue on merge — enforced here,
// not just in the prompt, so a compliant-looking-but-wrong body triggers a retry
// rather than opening a PR that leaves the issue open.
const PrOutput = z
  .object({
    prTitle: z.string().min(1).max(256),
    prDescription: z.string().min(1),
  })
  .refine(
    (o) =>
      new RegExp(`closes\\s+#${ctx.issueNumber}\\b`, "i").test(o.prDescription),
    {
      path: ["prDescription"],
      message: `prDescription must contain "Closes #${ctx.issueNumber}" so the PR closes the issue on merge`,
    },
  );

const result = await runWithRetry({
  name: `write-pr-#${ctx.issueNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: ctx.promptArgs,
  output: sandcastle.Output.object({ tag: "output", schema: PrOutput }),
});

fs.writeFileSync(
  path.join(ctx.outputDir, "pr_title.txt"),
  result.output.prTitle,
);
fs.writeFileSync(
  path.join(ctx.outputDir, "pr_description.txt"),
  result.output.prDescription,
);

console.log(`\nWrote PR metadata to ${ctx.outputDir}`);
console.log(`  title: ${result.output.prTitle}`);
