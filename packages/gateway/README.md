# @pedro_klein/pi-gateway

Virtual provider extension for [pi](https://github.com/earendil-works/pi-mono)
that exposes stable **tier aliases** (`heavy-1`, `medium-1`, `light-1`,
`xlight-1`, `minimal-1`) routing to already-registered pi providers with
automatic failover on cap hits (HTTP 402 / 429).

## Why

Family-neutral references let your prompts, extensions, and scripts say
`gateway/heavy-1` and stay stable when you swap backends (HAI ↔ Copilot ↔
whatever comes next). When one backend hits its daily cap, the alias
transparently swaps to the next healthy backend in your fallback chain.

## Install

```
pi install @pedro_klein/pi-gateway
```

Then create a per-machine `~/.pi/agent/aliases.json` (see below) and use
`gateway/heavy-1`, `gateway/medium-1`, etc. anywhere pi accepts a
`provider/model` reference.

## aliases.json format

`aliases.json` is a **pure mapping** — it never duplicates provider settings
(baseUrl, apiKey, api). Those live on already-registered pi providers; the
gateway reads them from `ctx.modelRegistry` at re-register time.

```json
{
  "fallbackChain": ["hai-proxy", "github-copilot"],
  "backends": {
    "hai-proxy": {
      "resetSchedule": "utc-midnight",
      "tiers": {
        "heavy":   "anthropic--claude-sonnet-4-5",
        "medium":  "anthropic--claude-haiku-4-5",
        "light":   "openai--gpt-5-mini",
        "xlight":  "openai--gpt-5-nano",
        "minimal": "openai--gpt-5-nano"
      },
      "quotaHint": "hai-daily-eur",
      "capStatusCodes": [402, 429]
    },
    "github-copilot": {
      "resetSchedule": "utc-monthly-1st",
      "tiers": {
        "heavy":  "claude-sonnet-4-5",
        "medium": "claude-haiku-4-5",
        "light":  "gpt-4o-mini"
      }
    }
  }
}
```

### Field reference

- `fallbackChain` (required): ordered list of backend names. The first
  healthy backend that declares a given tier wins routing for that
  family-neutral alias.
- `backends[name]` (required, at least one):
  - `tiers` (required, at least one): map of `heavy | medium | light | xlight | minimal` → real model ID as registered by the backing pi provider.
  - `resetSchedule` (optional): named preset for computing "next reset instant" after a cap hit. One of:
    - `utc-midnight` — daily reset at 00:00 UTC
    - `utc-monthly-1st` — monthly reset at 00:00 UTC on the 1st
    - `utc-hourly` — hourly reset at :00
    - Absent → default `now + 1h`.
  - `quotaHint` (optional): named parser that extracts `{ spent, cap, currency }` from the backend's cap-error body for the `/gateway` status view. v1: `hai-daily-eur`.
  - `capStatusCodes` (optional): HTTP status codes treated as cap hits. Default `[402, 429]`.

## Emitted aliases

For an aliases.json with two backends (`hai-proxy`, `github-copilot`) and
all 5 tier slots declared on each, the gateway emits **15 model entries**:

- 5 family-neutral: `heavy-1`, `medium-1`, `light-1`, `xlight-1`, `minimal-1`
- 10 family-pinned: `heavy-hai-1`, `medium-hai-1`, ..., `heavy-copilot-1`, ...

Family-neutral aliases follow the fallback chain and skip unhealthy
backends. Family-pinned aliases always route to the named backend — even
when that backend is unhealthy — providing an escape hatch when you need
deterministic routing.

## Usage examples

Reference from pi settings.json or `--model`:

```
pi --provider gateway --model heavy-1        # neutral heavy
pi --provider gateway --model heavy-hai-1    # pinned to hai-proxy
pi --provider gateway --model medium-1       # neutral medium
```

Reference from other extensions:

```typescript
pi.registerCommand("summarize", {
  handler: async (args, ctx) => {
    // Compose against the gateway's medium tier — routes wherever is healthy.
    const result = await ctx.modelRegistry.complete(
      ctx.modelRegistry.find("gateway", "medium-1"),
      context,
    );
  },
});
```

## `/gateway` command

- `/gateway` (or `/gateway status`) — print the current status view: header,
  backends (health + reset ETA + quota), aliases (routing map), footer.
- `/gateway force <backend>` — pin the active backend override.
- `/gateway force none` (or bare `/gateway force`) — clear the override.
- `/gateway clear` — clear all overrides.
- `/gateway toggle <backend>` — manually flip a backend between healthy and
  unhealthy for its normal reset window.
- `/gateway reload` — re-read `aliases.json` and `gateway-state.json` from
  disk, then re-register.

## How cap detection works

pi surfaces non-2xx provider responses as an assistant `message_end` event
with `stopReason: "error"` and `errorMessage` in the shape `"<status>: <body>"`
(e.g. `"402: {\"error\":{\"code\":\"DAILY_CAP_EXCEEDED\", ...}}"`). The
extension parses the status code, checks it against the backend's
`capStatusCodes`, and:

1. Writes an unhealthy entry to `~/.pi/agent/gateway-state.json` (atomically,
   with a same-machine lockfile).
2. If a `quotaHint` is configured, runs the enricher on the body and attaches
   `{ spent, cap, currency }` to the state entry for TUI display.
3. Debounces (within one microtask) a re-registration of the `gateway`
   provider so family-neutral aliases route around the unhealthy backend on
   the next request.
4. Emits a user-visible toast with the backend name and reset ETA.

TTL expiry is lazy: unhealthy entries whose `until` is in the past are
treated as healthy by the composer, and a `sweepExpiries()` call heals them.

## Token refresh

Every emitted gateway model entry embeds a **literal** `Bearer <resolved>`
header, resolved via `ctx.modelRegistry.getApiKeyForProvider(backend)` at
re-register time. To keep the literal fresh:

- Cap detection triggers re-registration on 402/429.
- A periodic timer (`PI_GATEWAY_OAUTH_REFRESH_MS`, default 30 minutes)
  re-registers whenever at least one backend has a non-static auth mode
  (OAuth, `!command`, `$ENV_VAR`).

The timer defers when the agent is streaming (`ctx.isIdle()` false) and
retries on the next tick.

## State file

`~/.pi/agent/gateway-state.json` (version 1):

```json
{
  "version": 1,
  "unhealthyUntil": {
    "hai-proxy": {
      "until": "2025-01-16T00:00:00.000Z",
      "reason": "HTTP 402 on heavy-hai-1 — cap hit",
      "quota": { "spent": 50.27, "cap": 50.00, "currency": "EUR" }
    }
  },
  "activeBackendOverride": null,
  "fallbackChainOverride": null
}
```

Concurrent writers are serialized via a same-machine lockfile at
`~/.pi/agent/gateway-state.json.lock` and atomic tmp+rename. Recommendation:
gitignore both `aliases.json` and `gateway-state.json`; they're per-machine.

## Environment variables

- `PI_GATEWAY_ALIASES_PATH` — override default `~/.pi/agent/aliases.json` location.
- `PI_GATEWAY_STATE_PATH` — override default `~/.pi/agent/gateway-state.json` location.
- `PI_GATEWAY_OAUTH_REFRESH_MS` — periodic re-registration interval (default `1800000`, i.e. 30 minutes).

## Limitations (v1)

- No full interactive `Component` TUI — `/gateway` is subcommand-driven for
  now. A component-based board is planned as a follow-up (see the deferred
  P5-T1 divergence in `plans/`).
- One `quotaHint` enricher shipped (`hai-daily-eur`). Add more entries to
  `src/enrichers.ts` as backend error formats are verified.
- Fallback chain ordering is static per config; no learned/adaptive
  ordering (yet).

## License

MIT
