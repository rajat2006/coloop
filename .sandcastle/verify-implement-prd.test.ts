import { describe, expect, it } from "vitest";
import { verifyImplementPrdOutcome } from "./verify-implement-prd";

describe("verifyImplementPrdOutcome — outcome vs commit-count consistency", () => {
  it("accepts completed with commits", () => {
    expect(verifyImplementPrdOutcome({ outcome: "completed", commitCount: 3 })).toEqual({
      ok: true,
    });
  });

  it("rejects completed with zero commits", () => {
    const v = verifyImplementPrdOutcome({ outcome: "completed", commitCount: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no commits/);
  });

  it("accepts already-satisfied with zero commits", () => {
    expect(
      verifyImplementPrdOutcome({ outcome: "already-satisfied", commitCount: 0 }),
    ).toEqual({ ok: true });
  });

  it("rejects already-satisfied with new commits (contradiction)", () => {
    const v = verifyImplementPrdOutcome({
      outcome: "already-satisfied",
      commitCount: 2,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/already-satisfied/);
  });

  it("always fails blocked, regardless of commit count", () => {
    for (const commitCount of [0, 5]) {
      const v = verifyImplementPrdOutcome({ outcome: "blocked", commitCount });
      expect(v.ok).toBe(false);
    }
  });
});
