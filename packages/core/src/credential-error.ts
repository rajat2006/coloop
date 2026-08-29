export class CredentialRejectedError extends Error {
  constructor() {
    super("provider_credential_rejected");
    this.name = "CredentialRejectedError";
  }
}

export const isCredentialRejectedError = (
  error: unknown,
): error is CredentialRejectedError => error instanceof CredentialRejectedError;
