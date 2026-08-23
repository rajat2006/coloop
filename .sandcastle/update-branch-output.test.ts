import { describe, expect, it } from "vitest";
import { updateBranchOutputSchema } from "./update-branch-output";

/** A minimal well-formed conflict resolution, spread-overridable per test. */
function conflict(overrides: Record<string, unknown> = {}) {
  return {
    file: "apps/web/src/trail/geometry.ts",
    resolution: "Kept the branch's new signature and re-applied the base's rename.",
    ...overrides,
  };
}

describe("updateBranchOutputSchema — the update-branch <output> contract", () => {
  it("accepts a merge that resolved conflicts", () => {
    const parsed = updateBranchOutputSchema.parse({
      outcome: "merged",
      summary: "Merged the base into the branch, resolving 2 conflicts.",
      conflicts: [conflict(), conflict({ file: "CONTEXT.md" })],
    });
    expect(parsed.outcome).toBe("merged");
    expect(parsed.conflicts).toHaveLength(2);
  });

  it("accepts a clean merge with zero conflicts", () => {
    const parsed = updateBranchOutputSchema.parse({
      outcome: "merged",
      summary: "Merged the base cleanly; no conflicts.",
      conflicts: [],
    });
    expect(parsed.conflicts).toEqual([]);
  });

  it("accepts an already-current branch (no-op merge)", () => {
    const parsed = updateBranchOutputSchema.parse({
      outcome: "already-current",
      summary: "Branch is already current with its base; nothing to do.",
      conflicts: [],
    });
    expect(parsed.outcome).toBe("already-current");
  });

  it("accepts a blocked outcome carrying a reason", () => {
    const parsed = updateBranchOutputSchema.parse({
      outcome: "blocked",
      summary: "Aborted the merge; a human is needed.",
      conflicts: [],
      reason: "The pricing rounding conflict in billing.ts needs a product call.",
    });
    expect(parsed.outcome).toBe("blocked");
    expect(parsed.reason).toContain("product call");
  });

  it("rejects a blocked outcome with no reason", () => {
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "blocked",
        summary: "Aborted.",
        conflicts: [],
      }),
    ).toThrow();
  });

  it("rejects a blocked outcome with an empty reason", () => {
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "blocked",
        summary: "Aborted.",
        conflicts: [],
        reason: "",
      }),
    ).toThrow();
  });

  it("rejects conflicts on an already-current outcome", () => {
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "already-current",
        summary: "contradictory",
        conflicts: [conflict()],
      }),
    ).toThrow();
  });

  it("rejects conflicts on a blocked outcome", () => {
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "blocked",
        summary: "contradictory",
        conflicts: [conflict()],
        reason: "needs a human",
      }),
    ).toThrow();
  });

  it("rejects an unknown outcome", () => {
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "rebased",
        summary: "s",
        conflicts: [],
      }),
    ).toThrow();
  });

  it("rejects a missing outcome", () => {
    expect(() =>
      updateBranchOutputSchema.parse({ summary: "s", conflicts: [] }),
    ).toThrow();
  });

  it("rejects a missing summary", () => {
    expect(() =>
      updateBranchOutputSchema.parse({ outcome: "merged", conflicts: [] }),
    ).toThrow();
  });

  it("rejects an empty summary", () => {
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "merged",
        summary: "",
        conflicts: [],
      }),
    ).toThrow();
  });

  it("rejects a missing conflicts array", () => {
    expect(() =>
      updateBranchOutputSchema.parse({ outcome: "merged", summary: "s" }),
    ).toThrow();
  });

  it("rejects a conflict missing its file", () => {
    const { file: _file, ...noFile } = conflict();
    expect(() =>
      updateBranchOutputSchema.parse({
        outcome: "merged",
        summary: "s",
        conflicts: [noFile],
      }),
    ).toThrow();
  });

  it("rejects an empty file or resolution", () => {
    for (const key of ["file", "resolution"]) {
      expect(() =>
        updateBranchOutputSchema.parse({
          outcome: "merged",
          summary: "s",
          conflicts: [conflict({ [key]: "" })],
        }),
      ).toThrow();
    }
  });
});
