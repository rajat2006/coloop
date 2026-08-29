import { describe, expect, test } from "vitest";
import { createPrivateAgentTracePolicy } from "./private-agent-tracing.js";

const eligibleConfiguration = () => ({
  ownerOptedIn: true,
  participantDisclosureVisible: true,
  restrictedAccessVerified: true,
  retentionAndDeletionVerified: true,
  trialStartedAt: "2026-08-01T00:00:00.000Z",
  consentingEpisodes: 1,
  acceptedAgentTurns: 2,
  billingEnabled: true,
  monthlyObservabilitySpendUsd: 4,
  killSwitch: () => false,
  now: () => new Date("2026-08-15T00:00:00.000Z"),
});

describe("private Agents SDK tracing policy", () => {
  test("allows full Agent capture only when every private-trial control is satisfied", () => {
    const policy = createPrivateAgentTracePolicy(eligibleConfiguration());

    expect(policy.decide("Authorized context and conversation.")).toEqual({
      enabled: true,
    });
  });

  test.each([
    ["Owner opt-in", { ownerOptedIn: false }, "owner-opt-in-required"],
    [
      "participant disclosure",
      { participantDisclosureVisible: false },
      "participant-disclosure-required",
    ],
    ["restricted access", { restrictedAccessVerified: false }, "restricted-access-required"],
    [
      "retention controls",
      { retentionAndDeletionVerified: false },
      "retention-controls-required",
    ],
    ["kill switch", { killSwitch: () => true }, "kill-switch"],
    ["30 days", { now: () => new Date("2026-08-31T00:00:00.001Z") }, "trial-ended"],
    ["30 Episodes", { consentingEpisodes: 30 }, "trial-ended"],
    ["300 turns", { acceptedAgentTurns: 300 }, "trial-ended"],
    ["$10 ceiling", { monthlyObservabilitySpendUsd: 10 }, "spend-ceiling"],
  ])("disables capture when %s is not satisfied", (_label, change, reason) => {
    const policy = createPrivateAgentTracePolicy({
      ...eligibleConfiguration(),
      ...change,
    });

    expect(policy.decide("Authorized context.")).toEqual({ enabled: false, reason });
  });

  test("unconditionally excludes credential-bearing Agent content", () => {
    const policy = createPrivateAgentTracePolicy(eligibleConfiguration());

    expect(
      policy.decide("A leaked key is sk-abcdefghijklmnopqrstuvwxyz123456."),
    ).toEqual({ enabled: false, reason: "credential-detected" });
  });

  test("ends capture when the 300th accepted Agent turn is recorded", () => {
    const policy = createPrivateAgentTracePolicy({
      ...eligibleConfiguration(),
      acceptedAgentTurns: 299,
    });

    expect(policy.decide("Authorized context.")).toEqual({ enabled: true });
    policy.recordAcceptedAgentTurn();
    expect(policy.decide("Authorized context.")).toEqual({
      enabled: false,
      reason: "trial-ended",
    });
  });

  test("updates consenting-Episode and monthly-spend trial limits", () => {
    const policy = createPrivateAgentTracePolicy(eligibleConfiguration());

    policy.recordConsentingEpisode(29);
    expect(policy.decide("Authorized context.")).toEqual({
      enabled: false,
      reason: "trial-ended",
    });

    const spendPolicy = createPrivateAgentTracePolicy(eligibleConfiguration());
    spendPolicy.updateMonthlyObservabilitySpendUsd(10);
    expect(spendPolicy.decide("Authorized context.")).toEqual({
      enabled: false,
      reason: "spend-ceiling",
    });
  });
});
