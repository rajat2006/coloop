import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCapabilityContext,
  loadIssueCapabilityContext,
  loadPrdImplementContext,
  loadPrdPrContext,
} from "./capability-context";
import {
  BUILD_CLAUDE_MODEL,
  CLAUDE_LABEL,
  CODEX_MODEL,
  DEFAULT_PROVIDER,
  THINK_CLAUDE_MODEL,
} from "./resolve-agent";

/**
 * The Sandcastle provider name an UNPINNED subject resolves to. Only the tests
 * that exercise the default path itself use this; every test that asserts a
 * specific model/effort pins the provider with an explicit label instead, so
 * flipping DEFAULT_PROVIDER moves nothing here.
 */
const DEFAULT_AGENT_NAME = DEFAULT_PROVIDER === "codex" ? "codex" : "claude-code";

const ENV_KEYS = [
  "ISSUE_NUMBER",
  "ISSUE_TITLE",
  "BRANCH",
  "BASE_BRANCH",
  "OUTPUT_DIR",
  "AGENT_LABELS",
];

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string> = {
    ISSUE_NUMBER: "63",
    ISSUE_TITLE: "agent-implement workflow",
    BRANCH: "agent/issue-63-agent-implement-workflow",
    BASE_BRANCH: "dev",
    OUTPUT_DIR: "/run/tmp",
    // Pinned to Claude so the model/effort assertions below test the
    // capability policy, not whatever DEFAULT_PROVIDER currently is.
    AGENT_LABELS: `["ready-for-agent","agent:implement","${CLAUDE_LABEL}"]`,
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("loadCapabilityContext", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("reads the issue coordinates and output dir from the environment", () => {
    setEnv();
    const ctx = loadCapabilityContext("implement");

    expect(ctx.issueNumber).toBe("63");
    expect(ctx.issueTitle).toBe("agent-implement workflow");
    expect(ctx.branch).toBe("agent/issue-63-agent-implement-workflow");
    expect(ctx.baseBranch).toBe("dev");
    expect(ctx.outputDir).toBe("/run/tmp");
  });

  it("exposes promptArgs shaped for {{...}} substitution", () => {
    setEnv();
    expect(loadCapabilityContext("implement").promptArgs).toEqual({
      ISSUE_NUMBER: "63",
      ISSUE_TITLE: "agent-implement workflow",
      BRANCH: "agent/issue-63-agent-implement-workflow",
      BASE_BRANCH: "dev",
    });
  });

  it("forwards the capability into resolution (implement → Build tier Claude)", () => {
    setEnv();
    const ctx = loadCapabilityContext("implement");
    expect(ctx.agent.name).toBe("claude-code");
    expect(ctx.model).toBe(BUILD_CLAUDE_MODEL);
    expect(ctx.effort).toBe("medium");
  });

  it("forwards a different capability's model + effort (review → Think tier)", () => {
    setEnv();
    const ctx = loadCapabilityContext("review");
    expect(ctx.model).toBe(THINK_CLAUDE_MODEL);
    expect(ctx.effort).toBe("high");
  });

  it("routes to Codex when agent:codex is anywhere in the label set", () => {
    setEnv({ AGENT_LABELS: '["agent:codex","agent:implement"]' });
    const ctx = loadCapabilityContext("implement");
    expect(ctx.agent.name).toBe("codex");
    expect(ctx.model).toBe(CODEX_MODEL);
    expect(ctx.labels).toContain("agent:codex");
  });

  it("treats absent AGENT_LABELS as an empty set (default provider)", () => {
    setEnv({ AGENT_LABELS: undefined });
    const ctx = loadCapabilityContext("implement");
    expect(ctx.labels).toEqual([]);
    expect(ctx.agent.name).toBe(DEFAULT_AGENT_NAME);
  });

  it("throws when a required var (OUTPUT_DIR) is missing", () => {
    setEnv({ OUTPUT_DIR: undefined });
    expect(() => loadCapabilityContext("implement")).toThrow("OUTPUT_DIR");
  });
});

describe("loadIssueCapabilityContext", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("loads a read-only issue capability without requiring a branch", () => {
    setEnv({ BRANCH: undefined });

    expect(loadIssueCapabilityContext("explore")).toMatchObject({
      issueNumber: "63",
      issueTitle: "agent-implement workflow",
      baseBranch: "dev",
      outputDir: "/run/tmp",
      // Think-tier resolution — distinct from the Build tier, so a resolver
      // that ignored the forwarded capability would fail here.
      model: THINK_CLAUDE_MODEL,
      effort: "high",
      promptArgs: {
        ISSUE_NUMBER: "63",
        ISSUE_TITLE: "agent-implement workflow",
        BASE_BRANCH: "dev",
      },
    });
  });

  it("routes a read-only issue capability from the full label set", () => {
    setEnv({
      BRANCH: undefined,
      AGENT_LABELS: '["agent:explore","agent:codex"]',
    });

    const ctx = loadIssueCapabilityContext("explore");
    expect(ctx.agent.name).toBe("codex");
    expect(ctx.model).toBe(CODEX_MODEL);
    // explore's Codex entry, not the old uniform medium — proves the capability
    // reached resolution on the Codex path too.
    expect(ctx.effort).toBe("xhigh");
    expect(ctx.labels).toEqual(["agent:explore", "agent:codex"]);
  });
});

const PRD_ENV_KEYS = [
  "PRD_NUMBER",
  "PRD_TITLE",
  "SUB_ISSUE_NUMBER",
  "SUB_ISSUE_TITLE",
  "BRANCH",
  "BASE_BRANCH",
  "OUTPUT_DIR",
  "AGENT_LABELS",
];

function setPrdEnv(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string> = {
    PRD_NUMBER: "52",
    PRD_TITLE: "Build the Sandcastle platform",
    SUB_ISSUE_NUMBER: "68",
    SUB_ISSUE_TITLE: "agent-implement-prd workflow",
    BRANCH: "agent/prd-52-build-the-sandcastle-platform",
    BASE_BRANCH: "dev",
    OUTPUT_DIR: "/run/tmp",
    // Pinned to Claude so the model/effort assertions below test the
    // capability policy, not whatever DEFAULT_PROVIDER currently is.
    AGENT_LABELS: `["ready-for-agent","agent:implement","${CLAUDE_LABEL}"]`,
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("loadPrdPrContext", () => {
  beforeEach(() => {
    for (const key of PRD_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of PRD_ENV_KEYS) delete process.env[key];
  });

  it("reads the PRD coordinates and output dir", () => {
    setPrdEnv();
    const ctx = loadPrdPrContext("write-prd-pr");
    expect(ctx.prdNumber).toBe("52");
    expect(ctx.prdTitle).toBe("Build the Sandcastle platform");
    expect(ctx.baseBranch).toBe("dev");
    expect(ctx.outputDir).toBe("/run/tmp");
  });

  it("exposes only PRD promptArgs (no sub-issue — the body is whole-PRD)", () => {
    setPrdEnv();
    expect(loadPrdPrContext("write-prd-pr").promptArgs).toEqual({
      PRD_NUMBER: "52",
      PRD_TITLE: "Build the Sandcastle platform",
      BASE_BRANCH: "dev",
    });
  });

  it("resolves the provider from the PRD's full label set", () => {
    setPrdEnv({ AGENT_LABELS: '["agent:codex","agent:implement"]' });
    const ctx = loadPrdPrContext("write-prd-pr");
    expect(ctx.agent.name).toBe("codex");
    expect(ctx.model).toBe(CODEX_MODEL);
  });

  it("forwards the capability into resolution (to-issues → Think tier, high)", () => {
    setPrdEnv();
    const ctx = loadPrdPrContext("to-issues");
    expect(ctx.model).toBe(THINK_CLAUDE_MODEL);
    expect(ctx.effort).toBe("high");
  });

  it("throws when a required var (PRD_NUMBER) is missing", () => {
    setPrdEnv({ PRD_NUMBER: undefined });
    expect(() => loadPrdPrContext("write-prd-pr")).toThrow("PRD_NUMBER");
  });
});

describe("loadPrdImplementContext", () => {
  beforeEach(() => {
    for (const key of PRD_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of PRD_ENV_KEYS) delete process.env[key];
  });

  it("reads the PRD coordinates, the sub-issue, and the branch", () => {
    setPrdEnv();
    const ctx = loadPrdImplementContext("implement-prd");
    expect(ctx.prdNumber).toBe("52");
    expect(ctx.subIssueNumber).toBe("68");
    expect(ctx.subIssueTitle).toBe("agent-implement-prd workflow");
    expect(ctx.branch).toBe("agent/prd-52-build-the-sandcastle-platform");
    expect(ctx.baseBranch).toBe("dev");
  });

  it("exposes promptArgs shaped for {{...}} substitution", () => {
    setPrdEnv();
    expect(loadPrdImplementContext("implement-prd").promptArgs).toEqual({
      PRD_NUMBER: "52",
      PRD_TITLE: "Build the Sandcastle platform",
      SUB_ISSUE_NUMBER: "68",
      SUB_ISSUE_TITLE: "agent-implement-prd workflow",
      BRANCH: "agent/prd-52-build-the-sandcastle-platform",
      BASE_BRANCH: "dev",
    });
  });

  it("resolves the provider from the PRD's full label set (pinned Claude)", () => {
    setPrdEnv();
    const ctx = loadPrdImplementContext("implement-prd");
    expect(ctx.agent.name).toBe("claude-code");
    expect(ctx.model).toBe(BUILD_CLAUDE_MODEL);
    expect(ctx.effort).toBe("medium");
  });

  it("forwards the caller's capability rather than assuming implement-prd", () => {
    setPrdEnv();
    // implement-prd's own entry matches the old global default, so prove the
    // forwarding wire with a capability whose policy is distinct.
    const ctx = loadPrdImplementContext("review");
    expect(ctx.model).toBe(THINK_CLAUDE_MODEL);
    expect(ctx.effort).toBe("high");
  });

  it("throws when the sub-issue var (SUB_ISSUE_NUMBER) is missing", () => {
    setPrdEnv({ SUB_ISSUE_NUMBER: undefined });
    expect(() => loadPrdImplementContext("implement-prd")).toThrow("SUB_ISSUE_NUMBER");
  });
});
