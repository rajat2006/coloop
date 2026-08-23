import { describe, expect, it } from "vitest";
import { verifyExploreReadOnly } from "./verify-explore-read-only";

describe("verifyExploreReadOnly", () => {
  it("accepts an unchanged HEAD and clean worktree", () => {
    expect(
      verifyExploreReadOnly({
        initialHead: "abc123",
        finalHead: "abc123",
        porcelainStatus: "",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a commit made during exploration", () => {
    expect(
      verifyExploreReadOnly({
        initialHead: "abc123",
        finalHead: "def456",
        porcelainStatus: "",
      }),
    ).toEqual({
      ok: false,
      reason: "Explore changed HEAD from abc123 to def456.",
    });
  });

  it("rejects tracked or untracked worktree changes", () => {
    expect(
      verifyExploreReadOnly({
        initialHead: "abc123",
        finalHead: "abc123",
        porcelainStatus: " M apps/web/src/App.tsx\n?? notes.md",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Explore left repository changes despite its read-only contract: M apps/web/src/App.tsx; ?? notes.md",
    });
  });
});
