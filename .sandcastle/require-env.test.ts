import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireEnv } from "./require-env";

const VAR = "REQUIRE_ENV_TEST_VAR";

describe("requireEnv", () => {
  beforeEach(() => {
    delete process.env[VAR];
  });
  afterEach(() => {
    delete process.env[VAR];
  });

  it("returns the value when the variable is set", () => {
    process.env[VAR] = "hello";
    expect(requireEnv(VAR)).toBe("hello");
  });

  it("throws, naming the variable, when it is unset", () => {
    expect(() => requireEnv(VAR)).toThrow(VAR);
  });

  it("treats an empty string as missing", () => {
    process.env[VAR] = "";
    expect(() => requireEnv(VAR)).toThrow(/Missing required/);
  });
});
