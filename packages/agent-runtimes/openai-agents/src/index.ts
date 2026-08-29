import { CredentialRejectedError } from "@coloop/core";

const openaiApi = "https://api.openai.com/v1";

export interface OpenAICredentialProvider {
  validateCredential(apiKey: string): Promise<void>;
}

export const createOpenAICredentialProvider = (): OpenAICredentialProvider => ({
  async validateCredential(apiKey) {
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
