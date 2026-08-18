---
"@pedro_klein/pi-gateway": minor
---

Register the `gateway` provider with **provider-level auth** so its tier aliases
are actually selectable in pi's `/model` picker and authenticate correctly.

pi (≥ 0.84) only treats a provider as "configured" — selectable and
authenticated — when it carries a provider-level `apiKey`/`oauth`; per-model
`Authorization` headers are ignored once provider auth resolves. The gateway now
resolves the effective backend's credential and registers it at the provider
level (escaped for pi's config-value resolver so opaque tokens and JSON service
keys survive), letting pi's native transport stream the response. Per-model
bearer headers are no longer baked.

Because one provider carries one credential, all emitted aliases must resolve to
a single backend at a time (health is per-backend, so they normally do). A
disjoint-tier config that would span two backends at once is degraded to the
primary backend with a warning.

Custom-transport backends (a non-built-in `api`) must have their transport
registered in pi's global api registry to be routable through the gateway.
