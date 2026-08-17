# pi-gateway

Virtual provider for [Pi](https://pi.dev) that exposes stable, **provider-agnostic
tier aliases** — `heavy-1`, `heavy-2`, `medium-1`, `light-1`, `light-2`, … —
routing to already-registered pi providers with automatic failover on cap hits
(HTTP 402 / 429).

The number in `<tier>-<N>` is a **diversity index**: each tier declares an
*ordered list* of models, and `heavy-1`, `heavy-2` route to the first, second,
… model in that list. This lets you keep several distinct models per tier
(e.g. `heavy-1` = Claude Opus, `heavy-2` = GPT-5.5) behind names that reveal
nothing about the backend underneath.

Reference `gateway/heavy-2` from prompts, extensions, subagents, and settings
without tying yourself to a specific backend. When a backend hits its daily
cap, the alias transparently fails over to the next healthy backend in your
fallback chain — the alias set stays stable so pinned references never break.

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

| Alias | Routes to |
|-------|-----------|
| `<tier>-<N>` (e.g. `heavy-1`, `heavy-2`, `light-1`) | The N-th model (1-based) in the tier's ordered list, served by the first healthy backend in the fallback chain that declares the tier. Provider-agnostic. |

The alias **count** per tier (how many `<tier>-<N>` exist) is fixed by the
first backend in the chain that declares the tier — this keeps the alias set
stable across cap transitions. Under failover, the index routes into the
healthy backend's list, **clamped** to its length: if that backend has fewer
models, the high indices reuse its last (best) model. Diversity is best-effort;
availability wins.

> **Note.** Family-pinned aliases (`heavy-hai-1` etc.) were **removed** — the
> alias names are intentionally backend-agnostic. Use `/gateway force <backend>`
> to pin routing to a specific backend when you need it.

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

Each tier value is either a **single model ID** or an **ordered list** of model
IDs. A list declares indexed diversity: index 1 → `<tier>-1`, index 2 →
`<tier>-2`, and so on. A single string is shorthand for a 1-element list.

```json
{
  "fallbackChain": ["hai-proxy", "sap-ai-core"],
  "backends": {
    "hai-proxy": {
      "resetSchedule": "utc-midnight",
      "tiers": {
        "heavy":   ["anthropic--claude-4.8-opus", "gpt-5.5"],
        "medium":  "anthropic--claude-4.6-sonnet",
        "light":   ["anthropic--claude-4.5-haiku", "gpt-5-mini"],
        "xlight":  "gemini-2.5-flash-lite",
        "minimal": "gemini-2.5-flash-lite"
      },
      "quotaHint": "hai-daily-eur",
      "capStatusCodes": [402, 429]
    },
    "sap-ai-core": {
      "tiers": {
        "heavy":  ["claude-4.8-opus", "gpt-5.5"],
        "medium": "claude-4.6-sonnet",
        "light":  ["claude-4.5-haiku", "gpt-5-mini"]
      }
    }
  }
}
```

With the config above, `hai-proxy` alone yields `gateway/heavy-1`
(Claude 4.8 Opus) and `gateway/heavy-2` (GPT-5.5) — two distinct models on one
backend, named agnostically.

**Field reference:**

- `fallbackChain` — ordered list of backend names. First healthy backend that declares a given tier wins routing for that tier's indexed aliases.
- `backends[name].tiers` — map of `heavy | medium | light | xlight | minimal` → a model ID **or an ordered list of model IDs** as registered by the backing pi provider. At least one tier required; a list may not be empty.
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
      "reason": "HTTP 402 on heavy-1 — cap hit",
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

**Indexed routing + failover.** For each tier the composer first fixes the
alias count `K` from the first backend in the effective chain
(`activeBackendOverride` first, then `fallbackChainOverride ?? fallbackChain`,
then any remaining backends) that declares the tier — *ignoring health*, so the
alias set `<tier>-1..<tier>-K` is stable across cap transitions. It then picks
the first **healthy** backend with a valid token that declares the tier and
emits `<tier>-1..K` routing into that backend's list, clamping the index to its
length. Unhealthy backends drop out transparently; when the router has fewer
models than `K`, high indices reuse its last model.

**Cap attribution.** Because indexed aliases are backend-agnostic, a cap hit on
`heavy-2` can't be attributed by name. The composer emits an `alias → backend`
routing map alongside the model list; the controller keeps the latest map and
uses it to attribute 402/429s to the exact backend the alias routed to. If no
map entry exists (e.g. a stale event), it falls back to the first chain backend
declaring that tier slot.

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
