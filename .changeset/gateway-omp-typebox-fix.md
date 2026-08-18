---
"@pedro_klein/pi-gateway": patch
---

Fix two oh-my-pi runtime crashes on session start, and load the built bundle on
both harnesses.

- **"Unknown type" / missing `/type` subpath (TypeBox).** pi and oh-my-pi each
  redirect a bare `@sinclair/typebox` import to their own bundled/facade typebox
  at extension-load time, and inconsistently across the root vs `/value`
  subpath — corrupting schema validation. TypeBox is now inlined into the build
  (`tsup` `noExternal`) and both entry points load the built `dist/*.js` instead
  of raw `src/*.ts`, so `Type`/`Value` always come from one real copy. The
  pi-family packages stay external so each host still resolves them to its own
  shared runtime (single api/model registry).

- **"registry.getProvider is not a function".** oh-my-pi's `ModelRegistry`
  exposes a different surface than pi's (`hasProvider`/`getProviderBaseUrl` vs
  `getProvider`/`getRegisteredProviderConfig`). Added an `adaptOmpRegistry`
  shim, injected via a new optional `GatewayPlatform.adaptRegistry` seam, so the
  shared resolver/session work unchanged on both harnesses.
