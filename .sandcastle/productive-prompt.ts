import * as fs from "node:fs";
import * as path from "node:path";

const marker = "<!-- PRODUCT_CI_RECOVERY -->";

export function loadProductivePrompt({
  promptFile,
  promptArgs,
}: {
  promptFile: string;
  promptArgs: Readonly<Record<string, string>>;
}): string {
  const capabilityPrompt = fs.readFileSync(promptFile, "utf8");
  const occurrences = capabilityPrompt.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Productive prompt ${promptFile} must contain exactly one ${marker} marker; found ${occurrences}.`,
    );
  }

  const sharedPrompt = fs.readFileSync(
    path.join(import.meta.dirname, "product-ci-prompt.md"),
    "utf8",
  );
  let resolved = capabilityPrompt.replace(marker, sharedPrompt.trim());
  for (const [key, value] of Object.entries(promptArgs)) {
    resolved = resolved.replaceAll(`{{${key}}}`, value);
  }
  const unresolved = resolved.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) {
    throw new Error(
      `Productive prompt ${promptFile} has unresolved arguments: ${[...new Set(unresolved)].join(", ")}.`,
    );
  }
  return resolved;
}
