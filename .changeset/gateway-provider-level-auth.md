---
"@pedro_klein/pi-gateway": minor
---

Make gateway tier aliases actually selectable **and routable**. Two coupled
fixes:

**Provider-level auth (selectability).** pi (≥ 0.84) only treats a provider as
"configured" — selectable in `/model` and authenticated at request time — when
it carries a provider-level `apiKey`/`oauth`; per-model `Authorization` headers
are ignored once provider auth resolves. The gateway now resolves the effective
backend's credential and registers it at the provider level (escaped for pi's
config-value resolver so opaque tokens and JSON service keys survive). Per-model
bearer headers are no longer baked.

**Custom `gateway` transport (routing).** pi sends `model.id` verbatim as the
wire model name, so registering models under a builtin api made backends reject
the alias (`Model name 'heavy-1' is not supported`). The gateway now registers
its own `gateway` api in pi's global api registry and its models with
`api: "gateway"`. At request time the transport maps the alias to the real
backend model (real wire id/api/baseUrl, captured at compose time) and delegates
to that backend's real transport via `getApiProvider`. Native streaming is
preserved; the real transport consumes `options.apiKey` as usual (bearer for
hai-proxy, service-key JSON for SAP AI Core). The routing map is refreshed on
every re-register, so failover reroutes transparently.

Because one provider carries one credential, all emitted aliases must resolve to
a single backend at a time (health is per-backend, so they normally do). A
disjoint-tier config that would span two backends at once is degraded to the
primary backend with a warning. Custom-transport backends must register their
`api` globally to be routable through the gateway.
