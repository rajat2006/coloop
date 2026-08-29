import { CredentialRejectedError } from "@coloop/core";

const openaiApi = "https://api.openai.com/v1";

export interface OpenAICredentialProvider {
  validateCredential(apiKey: string): Promise<void>;
}

export const createOpenAICredentialProvider = (): OpenAICredentialProvider => ({
  async validateCredential(apiKey) {
    // A lightweight models request validates the Platform key without starting an agent run.
    const response = await fetch(`${openaiApi}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      throw new CredentialRejectedError();
    }
    if (!response.ok) {
      throw new Error("provider_request_failed");
    }
    await response.body?.cancel();
  },
});
