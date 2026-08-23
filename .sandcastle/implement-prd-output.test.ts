import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_PRD_OUTCOMES,
  implementPrdOutputSchema,
} from "./implement-prd-output";

describe("implementPrdOutputSchema — the implement-prd outcome contract", () => {
  it("accepts each of the three outcomes with a reason", () => {
    for (const outcome of IMPLEMENT_PRD_OUTCOMES) {
      const parsed = implementPrdOutputSchema.parse({
        outcome,
        reason: "did the thing",
      });
      expect(parsed.outcome).toBe(outcome);
    }
  });

  it("rejects an unknown outcome", () => {
    expect(() =>
      implementPrdOutputSchema.parse({ outcome: "done", reason: "x" }),
    ).toThrow();
  });

  it("rejects a missing outcome", () => {
    expect(() =>
      implementPrdOutputSchema.parse({ reason: "x" }),
    ).toThrow();
  });

  it("rejects an empty or missing reason", () => {
    expect(() =>
      implementPrdOutputSchema.parse({ outcome: "blocked", reason: "" }),
    ).toThrow();
    expect(() =>
      implementPrdOutputSchema.parse({ outcome: "blocked" }),
    ).toThrow();
  });
});
