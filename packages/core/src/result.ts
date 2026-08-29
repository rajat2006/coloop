export type Result<Value, Reason extends string> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: Reason };

export type EmptyResult<Reason extends string> =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason };
