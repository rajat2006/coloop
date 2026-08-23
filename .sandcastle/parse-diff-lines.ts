/**
 * Parse a unified diff into the set of new-side line numbers each file *adds or
 * changes* — the lines a review finding may legitimately point at.
 *
 * A pure string-in / map-out function (no fs, no git): the review capability
 * feeds it a three-dot base-to-HEAD diff and uses the result to check that every
 * finding's `file:line` anchor falls on a line the PR actually touched, so the
 * posted comment can't point a reviewer at an unchanged line the agent imagined
 * (spec #52 / #65 — the pure diff parser behind `review-output` validation).
 *
 * Only `+` (added) lines are recorded: they are the new-side lines present in
 * the working tree at the numbers a reviewer would see. Context lines advance
 * the new-side counter but aren't themselves "changed"; `-` (deleted) lines
 * exist only on the old side and never get a new-side number.
 *
 * @param diff a unified diff (git's default `diff --git` format)
 * @returns file path (repo-relative, `b/` prefix stripped) → set of added
 *   new-side line numbers. Files with no added lines (pure deletions) are
 *   omitted; a deleted file (`+++ /dev/null`) never appears.
 */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();

  let currentFile: string | undefined;
  let newLine = 0;
  // Lines still expected in the current hunk, from its `@@` header counts. While
  // both are > 0 we are inside the hunk body, where a line starting with `+++ `
  // or `--- ` is *content* (an added/removed source line), not a file header.
  // This is what stops a source line like `+++ x` resetting the current file.
  let remainingNew = 0;
  let remainingOld = 0;

  for (const line of diff.split("\n")) {
    const inHunk = remainingNew > 0 || remainingOld > 0;

    // Hunk header: `@@ -oldStart,oldLen +newStart,newLen @@`. Resets the new-side
    // counter to newStart; each count is optional (absent ⇒ length 1). A `@@` at
    // column 0 only occurs as a header — body lines are prefixed with +/-/space.
    if (!inHunk && line.startsWith("@@")) {
      const match =
        /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        remainingOld = match[1] === undefined ? 1 : Number(match[1]);
        newLine = Number(match[2]);
        remainingNew = match[3] === undefined ? 1 : Number(match[3]);
      }
      continue;
    }

    // File headers only appear *between* hunks. `+++ b/path` (or `/dev/null`)
    // fixes the file the following hunks belong to; `--- ` carries no new-side
    // state. Inside a hunk these same prefixes are content, handled below.
    if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentFile = target === "/dev/null" ? undefined : stripPrefix(target);
      continue;
    }
    if (!inHunk) {
      // `--- ` old-side header, `diff --git …`, `index …`, mode lines, etc. —
      // nothing to record between hunks.
      continue;
    }

    // Inside a hunk body: classify by the leading marker and consume from the
    // hunk's line budget so we know when the body ends.
    if (line.startsWith("+")) {
      if (currentFile !== undefined) {
        addLine(byFile, currentFile, newLine);
      }
      newLine += 1;
      remainingNew -= 1;
    } else if (line.startsWith("-")) {
      // Deletion: old side only — the new-side counter does not advance.
      remainingOld -= 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a marker, consuming no line budget.
    } else {
      // Context line (leading space; an empty source line is exactly " ", and
      // git emits "" for it after a trailing-newline split): present on both
      // sides, so it advances the new counter and consumes from both budgets.
      newLine += 1;
      remainingNew -= 1;
      remainingOld -= 1;
    }
  }

  return byFile;
}

/** Strip git's `a/` or `b/` diff-path prefix, leaving the repo-relative path. */
function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function addLine(
  byFile: Map<string, Set<number>>,
  file: string,
  line: number,
): void {
  let set = byFile.get(file);
  if (!set) {
    set = new Set<number>();
    byFile.set(file, set);
  }
  set.add(line);
}
