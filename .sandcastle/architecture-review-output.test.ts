import { describe, expect, it } from "vitest";
import { architectureReviewOutputSchema } from "./architecture-review-output";

/** A well-formed `proposed` output, spread-overridable per test. */
function proposed(overrides: Record<string, unknown> = {}) {
  return {
    status: "proposed",
    oneLineSummary: "Proposed deepening the trail-geometry seam.",
    title: "Deepen the trail-geometry module behind a distance interface",
    body:
      "## Problem Statement\n...\n## Solution\n...\n## User Stories\n...\n" +
      "## Implementation Decisions\n...\n## Testing Decisions\n...\n" +
      "## Out of Scope\n...\n## Further Notes\n...",
    candidatesConsidered: [
      "trail-geometry distance seam",
      "stop-intake validation",
    ],
    ...overrides,
  };
}

/** A well-formed `skipped` output ({status, reason}, per CVM). */
function skipped(overrides: Record<string, unknown> = {}) {
  return {
    status: "skipped",
    reason: "No fresh deepening opportunity — top candidate already proposed.",
    ...overrides,
  };
}

describe("architectureReviewOutputSchema — the architecture-review <output> contract", () => {
  it("accepts a well-formed proposed output", () => {
    const parsed = architectureReviewOutputSchema.parse(proposed());
    expect(parsed.status).toBe("proposed");
    if (parsed.status === "proposed") expect(parsed.title).toBeTruthy();
  });

  it("accepts a well-formed skipped output ({status, reason})", () => {
    const parsed = architectureReviewOutputSchema.parse(skipped());
    expect(parsed.status).toBe("skipped");
    if (parsed.status === "skipped") expect(parsed.reason).toBeTruthy();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      architectureReviewOutputSchema.parse(proposed({ status: "deferred" })),
    ).toThrow();
  });

  it("rejects a proposed output missing its title", () => {
    const { title: _t, ...noTitle } = proposed();
    expect(() => architectureReviewOutputSchema.parse(noTitle)).toThrow();
  });

  it("rejects a proposed output missing its body", () => {
    const { body: _b, ...noBody } = proposed();
    expect(() => architectureReviewOutputSchema.parse(noBody)).toThrow();
  });

  it("rejects a title over GitHub's 256-char limit", () => {
    expect(() =>
      architectureReviewOutputSchema.parse(proposed({ title: "x".repeat(257) })),
    ).toThrow();
  });

  it("rejects a proposed output with an empty candidatesConsidered list", () => {
    expect(() =>
      architectureReviewOutputSchema.parse(proposed({ candidatesConsidered: [] })),
    ).toThrow();
  });

  it("rejects a proposed output with an empty candidate string", () => {
    expect(() =>
      architectureReviewOutputSchema.parse(
        proposed({ candidatesConsidered: ["ok", ""] }),
      ),
    ).toThrow();
  });

  it("rejects a skipped output missing its reason", () => {
    const { reason: _r, ...noReason } = skipped();
    expect(() => architectureReviewOutputSchema.parse(noReason)).toThrow();
  });

  it("rejects a skipped output that smuggles proposed fields (union is strict)", () => {
    expect(() =>
      architectureReviewOutputSchema.parse(
        skipped({ title: "x", body: "y", candidatesConsidered: ["z"] }),
      ),
    ).toThrow();
  });

  it("rejects a proposed output that smuggles a stray reason (union is strict)", () => {
    expect(() =>
      architectureReviewOutputSchema.parse(proposed({ reason: "nope" })),
    ).toThrow();
  });

  it("rejects a missing oneLineSummary on proposed", () => {
    const { oneLineSummary: _s, ...noSummary } = proposed();
    expect(() => architectureReviewOutputSchema.parse(noSummary)).toThrow();
  });
});
