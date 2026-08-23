import { describe, expect, it } from "vitest";
import { parseDiffLines } from "./parse-diff-lines";

describe("parseDiffLines — new-side line numbers a hunk adds or changes", () => {
  it("returns an empty map for an empty diff", () => {
    expect(parseDiffLines("").size).toBe(0);
    expect(parseDiffLines("   \n\n").size).toBe(0);
  });

  it("records the new-side line numbers of added lines in a single hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,4 @@",
      " const x = 1;",
      "+const y = 2;",
      "+const z = 3;",
      " const w = 4;",
    ].join("\n");

    const changed = parseDiffLines(diff);
    // context line 1 (x), +2 (y), +3 (z), context line 4 (w). Only additions.
    expect([...(changed.get("src/a.ts") ?? [])].sort((a, b) => a - b)).toEqual([
      2, 3,
    ]);
  });

  it("advances the new-side counter through context lines but not deletions", () => {
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,4 +1,4 @@",
      " a", // new line 1
      "-b", // deletion: no new-side line
      "+B", // new line 2
      " c", // new line 3
      "+D", // new line 4
    ].join("\n");

    expect([...(parseDiffLines(diff).get("f.ts") ?? [])].sort((a, b) => a - b)).toEqual([
      2, 4,
    ]);
  });

  it("handles multiple hunks in one file using each hunk's own start line", () => {
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b", // new line 2
      "@@ -10,2 +11,3 @@",
      " j", // new line 11
      "+k", // new line 12
      " l", // new line 13
    ].join("\n");

    expect([...(parseDiffLines(diff).get("f.ts") ?? [])].sort((a, b) => a - b)).toEqual([
      2, 12,
    ]);
  });

  it("keeps separate line sets per file across a multi-file diff", () => {
    const diff = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -0,0 +1,1 @@",
      "+first",
      "diff --git a/two.ts b/two.ts",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -5,0 +6,2 @@",
      "+alpha",
      "+beta",
    ].join("\n");

    const changed = parseDiffLines(diff);
    expect([...(changed.get("one.ts") ?? [])]).toEqual([1]);
    expect([...(changed.get("two.ts") ?? [])].sort((a, b) => a - b)).toEqual([6, 7]);
  });

  it("records added lines for a newly created file (--- /dev/null)", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");

    expect([...(parseDiffLines(diff).get("new.ts") ?? [])].sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  it("records no added lines for a deleted file (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
    ].join("\n");

    expect(parseDiffLines(diff).has("/dev/null")).toBe(false);
    expect(parseDiffLines(diff).has("gone.ts")).toBe(false);
  });

  it("ignores the no-newline marker and blank trailing content", () => {
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    expect([...(parseDiffLines(diff).get("f.ts") ?? [])]).toEqual([1]);
  });

  it("treats hunk-body lines starting with +++/--- as content, not file headers", () => {
    // An added source line whose text begins with `++ ` renders as `+++ …`, and
    // a removed line beginning with `-- ` renders as `--- …`. Inside a hunk these
    // must be classified by their marker, never mistaken for `+++ b/path` /
    // `--- a/path` file headers (which would reset the current file mid-hunk).
    const diff = [
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,3 +1,3 @@",
      " intro",
      "--- was a bullet", // deletion of a source line whose text is "-- was a bullet"
      "+++ now a bullet", // addition of a source line whose text is "++ now a bullet"
      " outro",
    ].join("\n");

    const changed = parseDiffLines(diff);
    // The addition lands on new-side line 2, still attributed to doc.md — the
    // `+++ now a bullet` content line did not hijack the current file.
    expect([...(changed.get("doc.md") ?? [])]).toEqual([2]);
    expect(changed.has("now a bullet")).toBe(false);
  });

  it("parses a single-line hunk header (@@ -a +c @@ with no counts)", () => {
    const diff = ["--- a/f.ts", "+++ b/f.ts", "@@ -1 +1 @@", "-old", "+new"].join(
      "\n",
    );

    expect([...(parseDiffLines(diff).get("f.ts") ?? [])]).toEqual([1]);
  });
});
