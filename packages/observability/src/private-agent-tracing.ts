const trialDurationMs = 30 * 24 * 60 * 60 * 1_000;

export type PrivateAgentTraceDecision =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly reason:
        | "owner-opt-in-required"
        | "participant-disclosure-required"
        | "restricted-access-required"
        | "retention-controls-required"
        | "kill-switch"
        | "trial-ended"
        | "spend-ceiling"
        | "credential-detected";
    };

export interface PrivateAgentTracePolicy {
  decide(agentContent: string): PrivateAgentTraceDecision;
  recordAcceptedAgentTurn(): void;
}

interface PrivateAgentTracePolicyConfiguration {
  readonly ownerOptedIn: boolean;
  readonly participantDisclosureVisible: boolean;
  readonly restrictedAccessVerified: boolean;
  readonly retentionAndDeletionVerified: boolean;
  readonly trialStartedAt: string;
  readonly consentingEpisodes: number;
  readonly acceptedAgentTurns: number;
  readonly billingEnabled: boolean;
  readonly monthlyObservabilitySpendUsd: number;
  readonly killSwitch: () => boolean;
  readonly now?: () => Date;
}

export function createPrivateAgentTracePolicy(
  configuration: PrivateAgentTracePolicyConfiguration,
): PrivateAgentTracePolicy {
  const trialStartedAt = Date.parse(configuration.trialStartedAt);
  if (Number.isNaN(trialStartedAt)) {
    throw new Error("The private trace trial start must be an ISO timestamp.");
  }
  const now = configuration.now ?? (() => new Date());
  let acceptedAgentTurns = configuration.acceptedAgentTurns;

  return {
    decide(agentContent) {
      if (!configuration.ownerOptedIn) {
        return { enabled: false, reason: "owner-opt-in-required" };
      }
      if (!configuration.participantDisclosureVisible) {
        return { enabled: false, reason: "participant-disclosure-required" };
      }
      if (!configuration.restrictedAccessVerified) {
        return { enabled: false, reason: "restricted-access-required" };
      }
      if (!configuration.retentionAndDeletionVerified) {
        return { enabled: false, reason: "retention-controls-required" };
      }
      if (configuration.killSwitch()) {
        return { enabled: false, reason: "kill-switch" };
      }
      if (
        now().getTime() - trialStartedAt >= trialDurationMs ||
        configuration.consentingEpisodes >= 30 ||
        acceptedAgentTurns >= 300
      ) {
        return { enabled: false, reason: "trial-ended" };
      }
      if (
        configuration.billingEnabled &&
        configuration.monthlyObservabilitySpendUsd >= 10
      ) {
        return { enabled: false, reason: "spend-ceiling" };
      }
      if (containsCredential(agentContent)) {
        return { enabled: false, reason: "credential-detected" };
      }
      return { enabled: true };
    },
    recordAcceptedAgentTurn() {
      acceptedAgentTurns += 1;
    },
  };
}

function containsCredential(content: string): boolean {
  return [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/,
  ].some((pattern) => pattern.test(content));
}
