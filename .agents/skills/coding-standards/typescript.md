# TypeScript conventions

## No `any`

Do not use `any`.

At untrusted boundaries, start with `unknown`, validate or narrow it, and keep
the validated type from that point onward. When a runtime schema or existing
API owns the shape, derive the TypeScript type from that source instead of
restating it.
