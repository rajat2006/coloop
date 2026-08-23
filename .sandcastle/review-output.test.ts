import { describe, expect, it } from "vitest";
import { reviewOutputSchema } from "./review-output";

/** A minimal well-formed finding, spread-overridable per test. */
function finding(overrides: Record<string, unknown> = {}) {
  return {
    axis: "standards",
    severity: "high",
    status: "unresolved",
    file: "apps/web/src/trail/geometry.ts",
    line: 42,
    title: "Duplicated distance calc",
    detail: "The haversine formula is inlined in two hunks; extract it.",
    ...overrides,
  };
}

describe("reviewOutputSchema — the review <output> contract", () => {
  it("accepts a full, well-formed review", () => {
    const parsed = reviewOutputSchema.parse({
      summary: "2 findings across both axes; one auto-fixed.",
      findings: [
        finding({ status: "fixed" }),
        finding({ axis: "spec", severity: "blocking", line: undefined }),
      ],
    });
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].status).toBe("fixed");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      reviewOutputSchema.parse({
        summary: "s",
        findings: [finding({ status: "wontfix" })],
      }),
    ).toThrow();
  });

  it("rejects a finding missing its status", () => {
    const { status: _status, ...noStatus } = finding();
    expect(() =>
      reviewOutputSchema.parse({ summary: "s", findings: [noStatus] }),
    ).toThrow();
  });

  it("accepts a clean review with zero findings", () => {
    const parsed = reviewOutputSchema.parse({
      summary: "No standards or spec issues found.",
      findings: [],
    });
    expect(parsed.findings).toEqual([]);
  });

  it("accepts a finding with no line anchor (line is optional)", () => {
    const { line: _line, ...noLine } = finding();
    expect(() =>
      reviewOutputSchema.parse({ summary: "s", findings: [noLine] }),
    ).not.toThrow();
  });

  it("rejects a missing summary", () => {
    expect(() => reviewOutputSchema.parse({ findings: [] })).toThrow();
  });

  it("rejects an empty summary", () => {
    expect(() =>
      reviewOutputSchema.parse({ summary: "", findings: [] }),
    ).toThrow();
  });

  it("rejects a missing findings array", () => {
    expect(() => reviewOutputSchema.parse({ summary: "s" })).toThrow();
  });

  it("rejects an unknown axis", () => {
    expect(() =>
      reviewOutputSchema.parse({
        summary: "s",
        findings: [finding({ axis: "performance" })],
      }),
    ).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() =>
      reviewOutputSchema.parse({
        summary: "s",
        findings: [finding({ severity: "catastrophic" })],
      }),
    ).toThrow();
  });

  it("rejects a finding missing its file", () => {
    const { file: _file, ...noFile } = finding();
    expect(() =>
      reviewOutputSchema.parse({ summary: "s", findings: [noFile] }),
    ).toThrow();
  });

  it("rejects an empty file, title, or detail", () => {
    for (const key of ["file", "title", "detail"]) {
      expect(() =>
        reviewOutputSchema.parse({
          summary: "s",
          findings: [finding({ [key]: "" })],
        }),
      ).toThrow();
    }
  });

  it("rejects a non-positive or non-integer line", () => {
    for (const line of [0, -1, 1.5]) {
      expect(() =>
        reviewOutputSchema.parse({
          summary: "s",
          findings: [finding({ line })],
        }),
      ).toThrow();
    }
  });
});
