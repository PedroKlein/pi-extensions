# pi-gateway

Virtual provider for [Pi](https://pi.dev) that exposes stable tier aliases —
`heavy-1`, `medium-1`, `light-1`, `xlight-1`, `minimal-1` — routing to
already-registered pi providers with automatic failover on cap hits (HTTP 402 /
429).

Reference `gateway/heavy-1` from prompts, extensions, and settings without
tying yourself to a specific backend. When one backend hits its daily cap, the
alias transparently swaps to the next healthy backend in your fallback chain.

## Install

```bash
pi install npm:@pedro_klein/pi-gateway
```

Create `~/.pi/agent/aliases.json` with your backends (see below) and start
using `gateway/heavy-1`, `gateway/medium-1`, etc. anywhere pi accepts a
`provider/model` reference.

## What it provides

**Provider:**

| Provider | Description |
|----------|-------------|
| `gateway` | Virtual pi provider registered at session start with one entry per tier alias |

**Aliases emitted:**

| Alias | Kind | Routes to |
|-------|------|-----------|
| `heavy-1`, `medium-1`, `light-1`, `xlight-1`, `minimal-1` | Family-neutral | First healthy backend in the fallback chain that declares this tier |
| `<tier>-<family>-1` (e.g. `heavy-hai-1`, `heavy-copilot-1`) | Family-pinned | Named backend, always — even when unhealthy |

**Commands:**

| Command | Description |
|---------|-------------|
| `/gateway` (alias `/gateway status`) | Print current status: header, backends (health + reset ETA + quota), aliases (routing map), keybindings |
| `/gateway force <backend>` | Set `activeBackendOverride` — pin routing to one backend |
| `/gateway force none` | Clear `activeBackendOverride` (bare `/gateway force` also clears) |
| `/gateway clear` | Clear all overrides |
| `/gateway toggle <backend>` | Manually flip a backend between healthy and unhealthy for its normal reset window |
| `/gateway reload` | Re-read `aliases.json` + `gateway-state.json` and re-register |

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_GATEWAY_ALIASES_PATH` | `~/.pi/agent/aliases.json` | Config file location |
| `PI_GATEWAY_STATE_PATH` | `~/.pi/agent/gateway-state.json` | Persistent state location |
| `PI_GATEWAY_OAUTH_REFRESH_MS` | `1800000` (30 min) | Periodic re-registration interval for non-static auth |

## aliases.json format

The config is a **pure mapping** — it never duplicates provider settings
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

**Field reference:**

- `fallbackChain` — ordered list of backend names. First healthy backend that declares a given tier wins routing for that neutral alias.
- `backends[name].tiers` — map of `heavy | medium | light | xlight | minimal` → real model ID as registered by the backing pi provider. At least one required.
- `backends[name].resetSchedule` (optional) — named preset for computing "next reset instant" after a cap hit:
  - `utc-midnight` — daily reset at 00:00 UTC
  - `utc-monthly-1st` — monthly reset at 00:00 UTC on the 1st
  - `utc-hourly` — hourly reset at :00
  - Absent → default `now + 1h`
- `backends[name].quotaHint` (optional) — named parser for extracting `{ spent, cap, currency }` from the backend's cap-error body, purely for the `/gateway` status view. v1 ships `hai-daily-eur`.
- `backends[name].capStatusCodes` (optional) — HTTP status codes treated as cap hits. Default `[402, 429]`.

## gateway-state.json format

`~/.pi/agent/gateway-state.json` (version `1`) — persistent per-machine state
written by the gateway. Editable via `/gateway` commands; hand-editing works
too.

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

Writes are atomic (tmp + rename) and serialized via a same-machine lockfile at
`~/.pi/agent/gateway-state.json.lock`. Both files are per-machine — gitignore
them.

## How it works

**Cap detection.** Pi surfaces non-2xx provider responses as an assistant
`message_end` event with `stopReason: "error"` and `errorMessage` in the shape
`"<status>: <body>"` — e.g. `"402: {\"error\":{\"code\":\"DAILY_CAP_EXCEEDED\", ...}}"`.
The extension parses the status code, checks it against the backend's
`capStatusCodes`, writes an unhealthy entry to `gateway-state.json` (atomically),
debounces a re-registration of the `gateway` provider (multiple
near-simultaneous transitions coalesce into one call), and emits a user-visible
toast with the backend name and reset ETA.

**Family-neutral routing.** When the composer emits `heavy-1`, it picks the
first backend in the effective chain (`activeBackendOverride` first, then
`fallbackChainOverride ?? fallbackChain`, then any remaining backends) that is
both healthy and declares the `heavy` tier. Unhealthy backends drop out
transparently; family-pinned aliases still route to their named backend even
when unhealthy.

**Token freshness.** Each emitted model entry embeds a literal
`Bearer <resolved-token>` header, resolved via
`ctx.modelRegistry.getApiKeyForProvider(backend)` at re-register time. Two
mechanisms keep the literal fresh:

- Cap detection triggers re-registration on 402/429.
- A periodic timer (`PI_GATEWAY_OAUTH_REFRESH_MS`, default 30 min)
  re-registers whenever at least one backend has a non-static auth mode
  (OAuth, `!command`, `$ENV_VAR`). The timer defers when the agent is
  streaming (`ctx.isIdle()` false) and retries on the next tick.

**TTL healing.** Unhealthy entries whose `until` is in the past are treated as
healthy by the composer. A `sweepExpiries()` call heals them and triggers
re-registration.

## Configuration

Everything is declared in `~/.pi/agent/aliases.json`. No settings.json entries
required beyond the standard `pi install`.

For a first-time setup, copy the example from the [aliases.json format](#aliasesjson-format)
section and adapt the backend names + model IDs to match your registered pi
providers (see `pi --list-models`).

## Development

```bash
pnpm test           # run tests (121 tests, 13 files)
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## Limitations (v1)

- `/gateway` is subcommand-driven text UI. A full interactive Component
  keybinding board is planned as a follow-up.
- One `quotaHint` enricher shipped (`hai-daily-eur`). Add more entries to
  `src/enrichers.ts` as backend error formats are verified.
- Fallback chain ordering is static per config; no learned/adaptive ordering.

## License

MIT
