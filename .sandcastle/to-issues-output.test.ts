import { describe, expect, it } from "vitest";
import { renderSliceBody, toIssuesOutputSchema } from "./to-issues-output";

/** A minimal well-formed slice, spread-overridable per test. */
function slice(overrides: Record<string, unknown> = {}) {
  return {
    title: "Add the .sandcastle scaffold end to end",
    whatToBuild: "Stand up the testable runner seam and prove it with a test.",
    acceptanceCriteria: ["turbo run test covers the seam", "Tests cover it"],
    ...overrides,
  };
}

describe("toIssuesOutputSchema — the to-issues <output> contract (CVM PromptOutput)", () => {
  it("accepts a well-formed ordered slice list", () => {
    const parsed = toIssuesOutputSchema.parse({
      slices: [slice(), slice({ title: "Provision agent:* labels" })],
    });
    expect(parsed.slices).toHaveLength(2);
    expect(parsed.slices[0].title).toContain("scaffold");
  });

  it("rejects an empty slices array — a decomposition needs a slice", () => {
    expect(() => toIssuesOutputSchema.parse({ slices: [] })).toThrow();
  });

  it("has no summary field — extra keys are stripped, not required", () => {
    const parsed = toIssuesOutputSchema.parse({
      summary: "ignored",
      slices: [slice()],
    });
    expect(parsed).not.toHaveProperty("summary");
  });

  it("strips any dependency field — list order is the only phase signal", () => {
    const parsed = toIssuesOutputSchema.parse({
      slices: [slice({ blockedBy: ["earlier"] })],
    });
    expect(parsed.slices[0]).not.toHaveProperty("blockedBy");
  });

  it("rejects a slice with an empty title", () => {
    expect(() =>
      toIssuesOutputSchema.parse({ slices: [slice({ title: "" })] }),
    ).toThrow();
  });

  it("rejects a slice with empty whatToBuild", () => {
    expect(() =>
      toIssuesOutputSchema.parse({ slices: [slice({ whatToBuild: "" })] }),
    ).toThrow();
  });

  it("rejects a slice with zero acceptance criteria", () => {
    expect(() =>
      toIssuesOutputSchema.parse({ slices: [slice({ acceptanceCriteria: [] })] }),
    ).toThrow();
  });

  it("rejects a slice title over CVM's 200-char limit", () => {
    expect(() =>
      toIssuesOutputSchema.parse({ slices: [slice({ title: "x".repeat(201) })] }),
    ).toThrow();
  });
});

describe("renderSliceBody — deterministic body rendering (CVM renderBody)", () => {
  it("renders the parent PRD reference, prose, and a checkbox list", () => {
    const body = renderSliceBody(slice(), 52);
    expect(body).toContain("## Parent PRD\n\n#52");
    expect(body).toContain("## What to build\n\nStand up the testable runner");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("- [ ] turbo run test covers the seam");
    expect(body).toContain("- [ ] Tests cover it");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("renders no dependency section — order carries phase", () => {
    expect(renderSliceBody(slice(), 52)).not.toContain("## Blocked by");
  });

  it("accepts a string PRD number", () => {
    expect(renderSliceBody(slice(), "69")).toContain("#69");
  });
});
