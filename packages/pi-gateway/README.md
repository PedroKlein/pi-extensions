# pi-gateway

Virtual provider for [Pi](https://pi.dev) that exposes stable, **provider-agnostic
tier aliases** — `heavy-1`, `heavy-2`, `medium-1`, `light-1`, `light-2`, … —
routing to already-registered pi providers with automatic same-request failover
on capacity limits, transient HTTP failures, and network errors.

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

**pi:**

```bash
pi install npm:@pedro_klein/pi-gateway
```

**oh-my-pi (omp):**

```bash
omp install @pedro_klein/pi-gateway
```

`omp install` accepts an npm spec (`@pedro_klein/pi-gateway[@version]`), a
marketplace ref (`name@marketplace`), or a local path — a local path is
*linked* (ideal for development):

```bash
# local dev: link the built package into omp
omp install /path/to/pi-extensions/packages/pi-gateway
```

oh-my-pi reads the `omp` manifest key (`omp.extensions` → `./dist/omp.js`),
falling back to `pi` if absent — so the same package serves both harnesses.
At load time oh-my-pi remaps pi-family imports (`@oh-my-pi/*`,
`@earendil-works/*`, `@mariozechner/*` for `pi-ai`/`pi-tui`/`pi-coding-agent`/…)
to its own bundled runtime, so the extension shares oh-my-pi's single api
registry — the routed alias delegates through the same `stream`/`streamSimple`
oh-my-pi dispatches natively (and the pi-tui helpers resolve even without
`@earendil-works/*` installed).

Then create `~/.pi/agent/aliases.json` with your backends (see below) and start
using `gateway/heavy-1`, `gateway/medium-1`, etc. anywhere the harness accepts a
`provider/model` reference.

> **oh-my-pi config path:** the config still defaults to
> `~/.pi/agent/aliases.json` (and `~/.pi/agent/gateway-state.json`) on omp. Set
> `PI_GATEWAY_ALIASES_PATH` / `PI_GATEWAY_STATE_PATH` to point at
> `~/.omp/agent/…` if you prefer to keep omp config separate.

### Harness support (pi + oh-my-pi)

pi-gateway runs on both **pi** (`@earendil-works/pi-coding-agent`) and
**oh-my-pi** (`@oh-my-pi/pi-coding-agent`). The package manifest declares both
entry points:

```jsonc
"pi":  { "extensions": ["./dist/index.js"] },  // pi
"omp": { "extensions": ["./dist/omp.js"] }     // oh-my-pi
```

Both entries load the **built bundle** (not raw `src`): TypeBox is inlined so
neither harness's typebox import-redirect can split `Type` from `Value`. Run
`pnpm build` before loading the extension from a local checkout.

Both share the same runtime, config, editor, and routing logic — only the
provider-registration and request-transport seams differ per harness:

| | pi | oh-my-pi |
|---|---|---|
| Provider registration | `registerProvider(name, { models, apiKey })` (per-model `api`/`baseUrl`) | `registerProvider(name, { api, baseUrl, apiKey, models })` (provider-level `baseUrl`) |
| Request dispatch | Registered backend provider (preserves its transport + resolved auth); global api fallback | `@oh-my-pi/pi-ai` top-level `stream`/`streamSimple` |
| Credential (`apiKey`) | escaped for pi's config-value `$`/`!` syntax | passed literally |

oh-my-pi caveats:

- **Single effective backend per registration.** oh-my-pi has no per-model
  `baseUrl`, so the gateway provider carries the effective backend's
  provider-level `baseUrl` + credential. This matches pi's existing
  single-credential model; failover across backends re-registers the provider
  before retrying through the next healthy route.
- The credential is forwarded to `apiKey` verbatim (no `$`/`!` escaping).
- **Extension-defined backend APIs must announce their transport.** OMP isolates
  extension imports from the host's custom-API registry, so a custom provider
  should answer the gateway's event-bus handshake after calling
  `registerProvider`:

  ```ts
  const announce = () => pi.events.emit("pi-gateway:register-transport", {
    api: "custom-api",
    stream,
    streamSimple,
  });
  pi.events.on("pi-gateway:request-transports", announce);
  announce();
  ```

  Built-in OMP APIs need no announcement. Emitting immediately plus answering
  requests makes the handshake independent of extension load order.

## What it provides

**Provider:**

| Provider | Description |
|----------|-------------|
| `gateway` | Virtual pi provider registered at session start with one entry per tier alias |

**Aliases emitted:**

| Alias | Routes to |
|-------|-----------|
| `<tier>-<N>` (e.g. `heavy-1`, `heavy-2`, `light-1`) | The N-th model (1-based) in the tier's ordered list, served by the first healthy backend in the fallback chain that declares the tier. The display name shows the live target as `<real model name> (<backend>)`. |

The alias **count** per tier (how many `<tier>-<N>` exist) is fixed by the
first backend in the chain that declares the tier — this keeps the alias set
stable across cap transitions. Under failover, the index routes into the
healthy backend's list, **clamped** to its length: if that backend has fewer
models, the high indices reuse its last (best) model. Diversity is best-effort;
availability wins.

> **Note.** Family-pinned aliases (`heavy-backend-a-1` etc.) were **removed** — the
> alias names are intentionally backend-agnostic. Use `/gateway force <backend>`
> to pin routing to a specific backend when you need it.

**Commands:**

| Command | Description |
|---------|-------------|
| `/gateway` (alias `/gateway status`) | Open the interactive board: header, backends (health + reset ETA + quota), aliases (routing map). Keys: `f` force backend · `c` clear overrides · `v` view models · `e` **edit aliases.json** · `r` reorder chain · `m` toggle health · `R` reload · `?` help · `q`/Esc quit. Falls back to a printed status snapshot when no interactive TUI is available (print/RPC). |
| `/gateway models` | Show the alias → provider → real model → status mapping — what each neutral alias (`heavy-1`, …) actually resolves to right now. Opens the board's models pane interactively, or prints a text table without a UI. |
| `/gateway force <backend>` | Set `activeBackendOverride` — pin routing to one backend |
| `/gateway force none` | Clear `activeBackendOverride` (bare `/gateway force` also clears) |
| `/gateway clear` | Clear all overrides |
| `/gateway toggle <backend>` | Manually flip a backend between healthy and unhealthy for its normal reset window |
| `/gateway reload` | Re-read `aliases.json` + `gateway-state.json` and re-register |

### Interactive config editor (`e` on the board)

The board's `e` key opens a full **`aliases.json` editor** — no hand-editing
required. Edits accumulate in an in-memory **draft**; nothing is written until
you press **`s` to save** (which validates the whole config, writes atomically,
then reloads + re-registers). Backing out with unsaved changes prompts to
discard, so every edit is reversible until you save.

What you can configure:

- **Backends** — add (`+ Add backend`, choosing from providers pi knows),
  rename (fallback-chain references update automatically), and delete.
- **Per-backend settings** — `resetSchedule` and `quotaHint` via preset
  pickers, and `capStatusCodes` via a text field.
- **Tiers × models** — for each tier (`heavy`/`medium`/`light`/`xlight`/
  `minimal`) multi-select and order models from that backend's live model
  list (the ordered selection becomes `heavy-1`, `heavy-2`, …).
- **Fallback chain** — toggle backend membership and reorder.

Editor keys: `↑↓`/`jk` move · `Enter` open/commit · `Space` toggle selection
(tiers/chain) · `Shift+J`/`Shift+K` reorder (chain) · type to filter pick-lists
or edit text · `s` save · `Esc` back (prompts if unsaved) · `?` help. Long
lists scroll to keep the cursor in view, and a breadcrumb shows where you are.

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
  "fallbackChain": ["openrouter", "groq"],
  "backends": {
    "openrouter": {
      "resetSchedule": "utc-midnight",
      "tiers": {
        "heavy":   ["anthropic/claude-opus-4", "openai/gpt-5"],
        "medium":  "anthropic/claude-sonnet-4",
        "light":   ["anthropic/claude-3.5-haiku", "openai/gpt-5-mini"],
        "xlight":  "google/gemini-2.0-flash-lite",
        "minimal": "google/gemini-2.0-flash-lite"
      },
      "quotaHint": "daily-eur-cap",
      "capStatusCodes": [402, 429]
    },
    "groq": {
      "tiers": {
        "heavy":  ["llama-3.3-70b", "openai/gpt-oss-120b"],
        "medium": "llama-3.3-70b",
        "light":  "llama-3.1-8b"
      }
    }
  }
}
```

With the config above, `openrouter` alone yields `gateway/heavy-1`
(Claude Opus 4) and `gateway/heavy-2` (GPT-5) — two distinct models on one
backend, named agnostically. When `openrouter` hits its cap, both fail over to
`groq`.

**Field reference:**

- `fallbackChain` — ordered list of backend names. First healthy backend that declares a given tier wins routing for that tier's indexed aliases.
- `backends[name].tiers` — map of `heavy | medium | light | xlight | minimal` → a model ID **or an ordered list of model IDs** as registered by the backing pi provider. At least one tier required; a list may not be empty.
- `backends[name].resetSchedule` (optional) — named preset for computing "next reset instant" after a cap hit:
  - `utc-midnight` — daily reset at 00:00 UTC
  - `utc-monthly-1st` — monthly reset at 00:00 UTC on the 1st
  - `utc-hourly` — hourly reset at :00
  - Absent → default `now + 1h`
- `backends[name].quotaHint` (optional) — named parser for extracting `{ spent, cap, currency }` from the backend's cap-error body, purely for the `/gateway` status view. v1 ships `daily-eur-cap` (matches a `DAILY_CAP_EXCEEDED` body with `cap_eur`/`spent_eur` fields).
- `backends[name].capStatusCodes` (optional) — HTTP status codes treated as cap hits. Default `[402, 429]`.

## gateway-state.json format

`~/.pi/agent/gateway-state.json` (version `1`) — persistent per-machine state
written by the gateway. Editable via `/gateway` commands; hand-editing works
too.

```json
{
  "version": 1,
  "unhealthyUntil": {
    "openrouter": {
      "until": "2025-01-16T00:00:00.000Z",
      "reason": "HTTP 402 on heavy-1 — capacity failure",
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

**Failure detection and retry.** Modern Pi and OMP expose provider failures via
`errorStatus`; older providers may embed the status in `errorMessage`. The
gateway treats each backend's `capStatusCodes` as capacity failures and also
recognizes transient statuses (`408`, `425`, `429`, `500`, `502`, `503`, `504`) plus
status-less network failures. Capacity failures stay unhealthy until their
configured reset schedule; transient failures cool down for five minutes.

When a qualifying failure occurs before any text, thinking, image, or tool-call
output has streamed, the gateway suppresses that failed attempt, atomically
persists the health transition, rebuilds the route with fresh backend auth, and
replays the same request through the next healthy backend. It can continue down
the fallback chain, but never retries a backend twice. Once semantic output has
started, it does not replay—the failed turn remains visible and only the next
request uses the new route, avoiding duplicated output or tool calls.

**Indexed routing + failover.** For each tier the composer first fixes the
alias count `K` from the first backend in the effective chain
(`activeBackendOverride` first, then `fallbackChainOverride ?? fallbackChain`,
then any remaining backends) that declares the tier — *ignoring health*, so the
alias set `<tier>-1..<tier>-K` is stable across cap transitions. It then picks
the first **healthy** backend with a valid token that declares the tier and
emits `<tier>-1..K` routing into that backend's list, clamping the index to its
length. Unhealthy backends drop out transparently; when the router has fewer
models than `K`, high indices reuse its last model.

**Failure attribution.** Because indexed aliases are backend-agnostic, a failure
on `heavy-2` can't be attributed by name. The composer emits an `alias → backend`
routing map alongside the model list; the controller keeps the latest map and
uses it to attribute failures to the exact backend the alias routed to. If no
map entry exists (e.g. a stale event), it falls back to the first chain backend
declaring that tier slot.

**Auth & selectability.** The `gateway` provider is registered with a
**provider-level** credential (`apiKey`) resolved from the effective backend via
`ctx.modelRegistry.getApiKeyForProvider(backend)` at re-register time. This is
required by pi (≥ 0.84): a provider is only "configured" — and therefore
selectable in the `/model` picker and authenticated at request time — when it
carries a provider-level `apiKey`/`oauth`. (Per-model `Authorization` headers
are ignored once provider auth resolves, so the gateway does **not** bake them.)
The resolved secret is escaped for pi's config-value resolver (`$`→`$$`, leading
`!`), so opaque bearer tokens and JSON service keys pass through intact.

**Request routing (why a custom transport).** pi sends `model.id` verbatim as
the wire model name — every builtin transport does `model: model.id`. A neutral
alias like `heavy-1` is *not* a real model name, so registering gateway models
under a builtin api makes the backend reject the request
(`Model name 'heavy-1' is not supported`). To fix this the gateway registers its
own api (`gateway`) in pi's **global** api registry and registers its models
with `api: "gateway"`. At request time pi resolves the provider credential into
`options.apiKey` and calls the gateway transport, which looks up the alias in a
live routing map, swaps in the **real** backend model (real wire id, api, and
baseUrl — captured at compose time), and delegates through that backend's
registered provider with the backend's own resolved API key, headers, base URL,
and environment. This is the same provider path used by a direct request, so
native streaming and provider-specific authentication or custom transport
behavior are preserved. The routing map is
replaced on every re-register, so failover transparently reroutes in-flight
aliases without re-registering the api.

**Single effective backend per registration.** Because one provider carries one
credential, all emitted aliases must resolve to a single backend at any moment.
Health is tracked per-backend, so neutral aliases normally all route to the same
backend (and fail over together). A disjoint-tier config that would route
different tiers to different backends simultaneously is degraded: the gateway
serves the **primary** backend's aliases and emits a warning naming the omitted
backends. Force or reorder to switch which backend is served.

**Custom-transport backends.** The gateway dispatches through the registered
backend provider rather than looking up only its `api` id. Providers created
with `createProvider` therefore work without separately exposing their custom
transport in pi's global api registry. A global-api lookup remains as a
compatibility fallback when an older registry cannot expose provider/auth
objects.

**Token freshness.** Two mechanisms keep the provider-level credential fresh:

- Capacity/transient failure detection triggers re-registration and bounded retry.
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
pnpm test           # run tests (200 tests, 21 files)
pnpm build          # build for publish
pnpm typecheck      # type-check without emitting
```

## Limitations (v1)

- One `quotaHint` enricher shipped (`daily-eur-cap`). Add more entries to
  `src/enrichers.ts` as backend error formats are verified.
- Fallback chain ordering is static per config; no learned/adaptive ordering.
- A single gateway provider carries one credential, so aliases spanning two
  backends simultaneously are degraded to the primary backend (see
  [How it works](#how-it-works)). This is rare because health is per-backend.

## License

MIT
