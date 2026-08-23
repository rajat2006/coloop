import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { loadPrdPrContext } from "../capability-context";
import { prepareCodexAuth } from "../prepare-codex-auth";
import { logResolvedAgent } from "../resolve-agent";
import { runWithRetry } from "../run-with-retry";
import {
  renderSliceBody,
  type Slice,
  toIssuesOutputSchema,
} from "../to-issues-output";

/**
 * The `to-issues-prd` capability: decompose a PRD issue into agent-sized child
 * issues (CVM's `to-issues-prd`, reconciled to this repository's seam).
 *
 * Invoked by `.github/workflows/agent-to-issues.yml` when a human applies
 * `agent:to-issues` to a PRD. The agent only *reads* the PRD and *emits* the
 * decomposition — it creates nothing. Because the structured output IS the work
 * (no branch, no commits, no files touched), this uses {@link runWithRetry},
 * matching CVM.
 *
 * The agent emits only output while the workflow performs issue creation. This
 * diverges from CVM's runner, which
 * does the `gh issue create` itself: here the slices are rendered and written to
 * `child_issues.json` for the workflow's create + sub-issue-link steps, keeping
 * every `gh` mutation in the workflow. Reads the PRD coordinates through the
 * shared {@link loadPrdPrContext} seam (PRD_NUMBER/PRD_TITLE) — no branch, so no
 * BRANCH env is involved.
 */

const ctx = loadPrdPrContext("to-issues");
logResolvedAgent(ctx);

// Same subscription-seat setup as every other capability — this phase runs the
// agent, so it authenticates identically (a no-op when the run resolved to Claude).
prepareCodexAuth(ctx.agent.name);

const result = await runWithRetry({
  name: `to-issues-prd-#${ctx.prdNumber}`,
  agent: ctx.agent,
  sandbox: noSandbox(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: ctx.promptArgs,
  output: sandcastle.Output.object({
    tag: "output",
    schema: toIssuesOutputSchema,
  }),
});

// Deterministically render each slice's body from its structured fields — the
// agent supplies the content, the runner owns the shape (parent back-reference +
// acceptance checklist), so a malformed body can never be published verbatim.
const rendered = result.output.slices.map((slice: Slice) => ({
  title: slice.title,
  body: renderSliceBody(slice, ctx.prdNumber),
}));

fs.writeFileSync(
  path.join(ctx.outputDir, "child_issues.json"),
  JSON.stringify(rendered, null, 2),
);

console.log(`\nWrote ${rendered.length} sub-issue(s) to ${ctx.outputDir}`);
for (const s of rendered) {
  console.log(`  - ${s.title}`);
}
