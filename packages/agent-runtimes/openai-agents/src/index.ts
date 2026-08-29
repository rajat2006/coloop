import type { EmptyResult } from "@coloop/core";

const openaiApi = "https://api.openai.com/v1";

export interface OpenAICredentialProvider {
  validateCredential(
    apiKey: string,
  ): Promise<EmptyResult<"credential-rejected" | "provider-unavailable">>;
}

export const createOpenAICredentialProvider = (): OpenAICredentialProvider => ({
  async validateCredential(apiKey) {
    // A lightweight models request validates the Platform key without starting an agent run.
    try {
      const response = await fetch(`${openaiApi}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) {
        return { ok: false, reason: "credential-rejected" };
      }
      if (!response.ok) {
        return { ok: false, reason: "provider-unavailable" };
      }
      await response.body?.cancel();
      return { ok: true };
    } catch {
      return { ok: false, reason: "provider-unavailable" };
    }
  },
});
