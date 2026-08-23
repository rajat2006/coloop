import { describe, expect, it } from "vitest";
import { exploreOutputSchema } from "./explore-output";

describe("exploreOutputSchema — the explore <output> contract", () => {
  it("accepts a non-empty issue exploration comment", () => {
    expect(
      exploreOutputSchema.parse({
        comment:
          "## Assessment\n\nThe issue is valid and likely touches the workflow seam.",
      }),
    ).toEqual({
      comment:
        "## Assessment\n\nThe issue is valid and likely touches the workflow seam.",
    });
  });

  it("rejects an empty exploration comment", () => {
    expect(() => exploreOutputSchema.parse({ comment: "" })).toThrow();
  });

  it("rejects a whitespace-only exploration comment", () => {
    expect(() => exploreOutputSchema.parse({ comment: "  \n\t" })).toThrow();
  });

  it("rejects output with no comment", () => {
    expect(() => exploreOutputSchema.parse({})).toThrow();
  });
});
