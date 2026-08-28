# Results and testing

## Recoverable results

When a caller must branch on a recoverable success or failure, use the
repository's discriminated result shape:

```ts
{ readonly ok: true } | { readonly ok: false; readonly reason: string }
```

Add success data to the `ok: true` variant. Use more specific failure fields
such as `error` or `diagnostics` when the caller needs those distinctions.

## Tests

Keep focused Vitest tests beside the TypeScript implementation as `*.test.ts`.
When behavior changes, update or add the colocated test that demonstrates the
new contract. Exercise externally visible outcomes and important failure paths.
