import type { EmptyResult } from "./result.js";

export interface EpisodeAgent {
  streamResponse(input: {
    readonly contextPackage: string;
    readonly message: string;
    readonly previousResponseId?: string;
    readonly onTextDelta: (
      delta: string,
    ) =>
      | Promise<EmptyResult<"delivery-failed">>
      | EmptyResult<"delivery-failed">;
  }): Promise<
    | { readonly ok: true; readonly responseId: string }
    | {
        readonly ok: false;
        readonly reason: "delivery-failed" | "provider-failed";
      }
  >;
  synthesizeOutcomeProposal(input: {
    readonly contextPackage: string;
    readonly message: string;
    readonly previousResponseId?: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly responseId: string;
        readonly candidate: unknown;
      }
    | { readonly ok: false; readonly reason: "provider-failed" }
  >;
}
