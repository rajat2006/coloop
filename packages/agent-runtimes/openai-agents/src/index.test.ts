import { afterEach, describe, expect, test, vi } from "vitest";
import { createOpenAICredentialProvider } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI Platform credential validation", () => {
  test("accepts a credential without starting an agent run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );

    await expect(
      createOpenAICredentialProvider().validateCredential("valid-key"),
    ).resolves.toEqual({ ok: true });
  });

  test("distinguishes a rejected credential from provider unavailability", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const provider = createOpenAICredentialProvider();

    await expect(provider.validateCredential("rejected-key")).resolves.toEqual({
      ok: false,
      reason: "credential-rejected",
    });
    await expect(provider.validateCredential("valid-key")).resolves.toEqual({
      ok: false,
      reason: "provider-unavailable",
    });
  });
});
