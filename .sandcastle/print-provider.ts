/**
 * The workflows' window onto {@link resolveProvider} (issue: switchable default
 * provider). A workflow needs the resolved provider for its *setup* — whether
 * to install the Codex CLI, and which provider label to propagate onto a PR —
 * and previously each one re-implemented the rule in `jq`. That duplication is
 * exactly what breaks when `DEFAULT_PROVIDER` flips, so the shell asks the
 * resolver instead.
 *
 * Usage (after `pnpm install`, from a step that has AGENT_LABELS set):
 *
 *   pnpm --dir .sandcastle exec tsx print-provider.ts >> "$GITHUB_OUTPUT"
 *
 * Emits GitHub-Actions `key=value` lines on stdout:
 *
 *   provider=claude|codex
 *   is_codex=true|false
 *   provider_label=agent:claude|agent:codex
 *
 * AGENT_LABELS is the subject's full label set as a JSON array (the same value
 * the runners receive). Unset or unparseable is treated as an empty set, which
 * resolves to the default — the same fallback the runners take.
 */
import { CLAUDE_LABEL, CODEX_LABEL, resolveProvider } from "./resolve-agent";

function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l === "string") : [];
  } catch {
    return [];
  }
}

const provider = resolveProvider(parseLabels(process.env.AGENT_LABELS));

console.log(`provider=${provider}`);
console.log(`is_codex=${provider === "codex"}`);
console.log(
  `provider_label=${provider === "codex" ? CODEX_LABEL : CLAUDE_LABEL}`,
);
