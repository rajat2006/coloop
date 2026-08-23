import { describe, expect, it } from "vitest";
import {
  verifyBranchUpdate,
  type BranchUpdateFacts,
} from "./verify-branch-update";

/**
 * A fully-successful `merged` snapshot: base incorporated, HEAD advanced (a new
 * commit landed), clean tree, no lingering merge state. Spread-overridable per test.
 */
function facts(overrides: Partial<BranchUpdateFacts> = {}): BranchUpdateFacts {
  return {
    claimedOutcome: "merged",
    baseRef: "origin/dev",
    baseIsAncestor: true,
    baseWasAncestorBefore: false,
    inMergeState: false,
    unresolvedPaths: [],
    treeDirty: false,
    headBefore: "aaaa",
    headAfter: "bbbb",
    ...overrides,
  };
}

describe("verifyBranchUpdate — deterministic post-merge postconditions", () => {
  it("passes a genuine merge (HEAD moved, base incorporated, clean)", () => {
    expect(verifyBranchUpdate(facts())).toEqual({ ok: true });
  });

  it("passes a genuine already-current no-op (HEAD unchanged, base was ancestor)", () => {
    const verdict = verifyBranchUpdate(
      facts({
        claimedOutcome: "already-current",
        baseWasAncestorBefore: true,
        headBefore: "aaaa",
        headAfter: "aaaa",
      }),
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("fails a blocked claim outright — it must never be pushed", () => {
    const verdict = verifyBranchUpdate(facts({ claimedOutcome: "blocked" }));
    expect(verdict.ok).toBe(false);
  });

  it("fails when the repo is still mid-merge (MERGE_HEAD present)", () => {
    const verdict = verifyBranchUpdate(facts({ inMergeState: true }));
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toMatch(/mid-merge|MERGE_HEAD/);
  });

  it("fails when unresolved paths remain, naming them", () => {
    const verdict = verifyBranchUpdate(
      facts({ unresolvedPaths: ["a.ts", "b.ts"] }),
    );
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toContain("a.ts, b.ts");
  });

  it("fails when the working tree is dirty (resolution not committed)", () => {
    const verdict = verifyBranchUpdate(facts({ treeDirty: true }));
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toMatch(/uncommitted/);
  });

  it("fails when the base is not an ancestor of HEAD (aborted merge)", () => {
    const verdict = verifyBranchUpdate(facts({ baseIsAncestor: false }));
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toMatch(/not an ancestor/);
  });

  it("fails a 'merged' claim where HEAD did not advance (no new commit)", () => {
    const verdict = verifyBranchUpdate(
      facts({ headBefore: "aaaa", headAfter: "aaaa" }),
    );
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toMatch(/HEAD did not advance/);
  });

  it("fails an 'already-current' claim where HEAD moved (a commit was made)", () => {
    const verdict = verifyBranchUpdate(
      facts({
        claimedOutcome: "already-current",
        baseWasAncestorBefore: true,
        headBefore: "aaaa",
        headAfter: "bbbb",
      }),
    );
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toMatch(/HEAD moved/);
  });

  it("fails an 'already-current' claim where the base was not an ancestor before", () => {
    const verdict = verifyBranchUpdate(
      facts({
        claimedOutcome: "already-current",
        baseWasAncestorBefore: false,
        headBefore: "aaaa",
        headAfter: "aaaa",
      }),
    );
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toMatch(/not an ancestor.*before/);
  });
});
