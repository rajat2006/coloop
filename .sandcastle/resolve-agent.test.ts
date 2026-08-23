import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Capability,
  BUILD_CLAUDE_MODEL,
  CLAUDE_LABEL,
  CODEX_LABEL,
  CODEX_MODEL,
  DEFAULT_PROVIDER,
  THINK_CLAUDE_MODEL,
  resolveAgent,
  resolveProvider,
} from "./resolve-agent";

/**
 * The capability policy, restated here from issue #88's table as the independent
 * source of truth the resolver is checked against. Table-driven so a missing
 * policy entry or an accidental fallback is visible: every capability names its
 * exact Claude and Codex model + effort.
 */
const build = {
  claudeModel: "claude-opus-4-8",
  claudeEffort: "medium",
  codexModel: "gpt-5.6-sol",
  codexEffort: "medium",
};
const thinkLight = {
  claudeModel: "claude-fable-5",
  claudeEffort: "medium",
  codexModel: "gpt-5.6-sol",
  codexEffort: "medium",
};
const thinkHeavy = {
  claudeModel: "claude-fable-5",
  claudeEffort: "high",
  codexModel: "gpt-5.6-sol",
  codexEffort: "xhigh",
};
const POLICY: Record<
  Capability,
  {
    claudeModel: string;
    claudeEffort: string;
    codexModel: string;
    codexEffort: string;
  }
> = {
  implement: build,
  "implement-prd": build,
  "implement-pr": build,
  "update-branch": build,
  "write-pr": thinkLight,
  "write-prd-pr": thinkLight,
  review: thinkHeavy,
  "to-issues": thinkHeavy,
  "architecture-review": thinkHeavy,
  explore: thinkHeavy,
};

const CAPABILITIES = Object.keys(POLICY) as Capability[];

describe("resolveAgent — capability-specific model and effort policy", () => {
  describe.each(CAPABILITIES)("capability %s", (capability) => {
    const expected = POLICY[capability];

    it("resolves the Claude entry when pinned to Claude", () => {
      const { agent, model, effort } = resolveAgent(
        [CLAUDE_LABEL, "ready-for-agent"],
        capability,
      );

      expect(agent.name).toBe("claude-code");
      expect(model).toBe(expected.claudeModel);
      expect(effort).toBe(expected.claudeEffort);
    });

    it("builds Claude Code with the configured effort", () => {
      const { agent } = resolveAgent([CLAUDE_LABEL], capability);

      expect(
        agent.buildPrintCommand({
          prompt: "Inspect the issue",
          dangerouslySkipPermissions: true,
        }).command,
      ).toContain(`--effort ${expected.claudeEffort}`);
    });

    it("resolves the Codex entry when pinned to Codex", () => {
      const { agent, model, effort } = resolveAgent(
        [CODEX_LABEL, "ready-for-agent"],
        capability,
      );

      expect(agent.name).toBe("codex");
      expect(model).toBe(expected.codexModel);
      expect(effort).toBe(expected.codexEffort);
    });

    it("builds Codex with the configured reasoning effort", () => {
      const { agent } = resolveAgent(["agent:codex"], capability);

      expect(
        agent.buildPrintCommand({
          prompt: "Inspect the issue",
          dangerouslySkipPermissions: true,
        }).command,
      ).toContain(`model_reasoning_effort="${expected.codexEffort}"`);
    });
  });

  it("puts a Build-tier capability on claude-opus-4-8 at medium", () => {
    const { model, effort } = resolveAgent([CLAUDE_LABEL], "implement");
    expect(model).toBe(BUILD_CLAUDE_MODEL);
    expect(model).toBe("claude-opus-4-8");
    expect(effort).toBe("medium");
  });

  it("puts a Think-tier capability on claude-fable-5 at its stated effort", () => {
    const { model, effort } = resolveAgent([CLAUDE_LABEL], "review");
    expect(model).toBe(THINK_CLAUDE_MODEL);
    expect(model).toBe("claude-fable-5");
    expect(effort).toBe("high");
  });

  it("keeps every capability on the one Codex model", () => {
    for (const capability of CAPABILITIES) {
      expect(resolveAgent(["agent:codex"], capability).model).toBe(CODEX_MODEL);
    }
  });

  it("treats an empty label set as the default provider", () => {
    const { agent } = resolveAgent([], "implement");
    expect(agent.name).toBe(
      DEFAULT_PROVIDER === "codex" ? "codex" : "claude-code",
    );
  });

  it("finds agent:codex regardless of its position in the set", () => {
    const { agent } = resolveAgent(
      ["agent:implement", "ready-for-agent", "agent:codex"],
      "implement",
    );
    expect(agent.name).toBe("codex");
  });

  it("does not treat a lookalike label as a provider switch", () => {
    expect(
      resolveProvider(["agent:codex-experimental", "codex", "agent:claude-x"]),
    ).toBe(DEFAULT_PROVIDER);
  });
});

describe("resolveProvider — explicit label wins, otherwise the default", () => {
  it("pins to Codex on agent:codex", () => {
    expect(resolveProvider([CODEX_LABEL])).toBe("codex");
  });

  it("pins to Claude on agent:claude", () => {
    expect(resolveProvider([CLAUDE_LABEL])).toBe("claude");
  });

  it("pins regardless of the label's position in the set", () => {
    expect(
      resolveProvider(["agent:implement", "ready-for-agent", CODEX_LABEL]),
    ).toBe("codex");
    expect(
      resolveProvider(["agent:implement", "ready-for-agent", CLAUDE_LABEL]),
    ).toBe("claude");
  });

  it("falls back to the default when neither provider label is present", () => {
    expect(resolveProvider([])).toBe(DEFAULT_PROVIDER);
    expect(resolveProvider(["agent:implement", "ready-for-agent"])).toBe(
      DEFAULT_PROVIDER,
    );
  });

  it("falls back to the default when BOTH provider labels are present", () => {
    // Ambiguous pinning resolves to the default rather than silently preferring
    // one label over the other.
    expect(resolveProvider([CLAUDE_LABEL, CODEX_LABEL])).toBe(DEFAULT_PROVIDER);
  });

  it("keeps DEFAULT_PROVIDER to the two supported providers", () => {
    expect(["claude", "codex"]).toContain(DEFAULT_PROVIDER);
  });
});

describe("resolveAgent — Codex session storage under CODEX_HOME", () => {
  it("finds Codex resumable sessions under CODEX_HOME", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const sessionId = "session-from-configured-home";
    const sessionPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "07",
      `rollout-test-${sessionId}.jsonl`,
    );
    const originalCodexHome = process.env.CODEX_HOME;

    try {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, "{}");
      process.env.CODEX_HOME = codexHome;

      const { agent } = resolveAgent(["agent:codex"], "implement");
      const found = await agent.sessionStorage?.findByIdOnHost(sessionId);

      expect(found?.path).toBe(sessionPath);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("falls back to HOME/.codex for Codex resumable sessions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    const sessionId = "session-from-default-home";
    const sessionPath = path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "07",
      `rollout-test-${sessionId}.jsonl`,
    );
    const originalCodexHome = process.env.CODEX_HOME;
    const originalHome = process.env.HOME;

    try {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, "{}");
      delete process.env.CODEX_HOME;
      process.env.HOME = home;

      const { agent } = resolveAgent(["agent:codex"], "implement");
      const found = await agent.sessionStorage?.findByIdOnHost(sessionId);

      expect(found?.path).toBe(sessionPath);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
