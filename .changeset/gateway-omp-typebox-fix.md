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

- **"Unhandled API in mapOptionsForApi: gateway".** Registering the `gateway`
  custom api directly (via the redirected `@oh-my-pi/pi-ai` root) lands in a
  different bundled pi-ai instance than the one the host dispatches through, so
  `getCustomApi("gateway")` was empty at request time. On oh-my-pi the gateway's
  `streamSimple` delegate is now passed through `registerProvider`, which calls
  oh-my-pi's *internal* `registerCustomApi` — the instance `getCustomApi` reads.
  Verified end-to-end on the real oh-my-pi runtime: a `gateway/*` request routes
  to the real backend model and hits the real transport.
