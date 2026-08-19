# @pedro_klein/pi-gateway

## 0.5.1

### Patch Changes

- 793c09d: Fix two oh-my-pi runtime crashes on session start, and load the built bundle on
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
    oh-my-pi's _internal_ `registerCustomApi` — the instance `getCustomApi` reads.
    Verified end-to-end on the real oh-my-pi runtime: a `gateway/*` request routes
    to the real backend model and hits the real transport.

## 0.5.0

### Minor Changes

- c003ebb: Add an interactive `/gateway` board and a `/gateway models` view.

  `/gateway` (and `/gateway status`) now open a centered TUI overlay whose footer
  keys are wired to real actions — `f` force a backend, `c` clear overrides, `r`
  reorder the fallback chain (Shift+J/K to move entries), `m` toggle backend
  health, `v` view the models mapping, `R` reload from disk, `q`/Esc to quit.
  Without an interactive TUI (print/RPC) it falls back to the previous printed
  status snapshot.

  `/gateway models` reveals what each neutral alias hides: the alias → provider
  (backend) → real model → live status mapping, so you can see that e.g.
  `heavy-1` currently routes to `hai-proxy/anthropic--claude-4.8-opus`. Opens the
  board's models pane interactively, or prints a text table without a UI.

- 6d911ed: Add oh-my-pi (`@oh-my-pi/pi-coding-agent`) support alongside pi.

  The extension now ships two entry points that share one runtime, config,
  editor, and routing core:

  - `pi.extensions` → `./src/index.ts` (pi / `@earendil-works`)
  - `omp.extensions` → `./src/omp.ts` (oh-my-pi / `@oh-my-pi`)

  Only the two harness seams differ, behind injectable adapters:

  - **Transport** — a new harness-agnostic `transport-core` (`createGatewayTransport({ registerApi, deliver })`) maps a stable alias to its real backend model at request time. pi wires it to `@earendil-works/pi-ai/compat` (`registerApiProvider` + `getApiProvider`); oh-my-pi wires it to `@oh-my-pi/pi-ai` (`registerCustomApi` + top-level `stream`/`streamSimple`, which route both custom and builtin backend apis).
  - **Provider registration** — pi keeps per-model `api`/`baseUrl`; oh-my-pi uses a provider-level `baseUrl` (it has no per-model `baseUrl`) drawn from the single effective backend, and receives the credential literally (no pi config-value `$`/`!` escaping).

  No behavior change for pi users. The credential-escaping step moved from the
  shared session pipeline into the pi register adapter (unchanged pi output).

- cc837ad: Make gateway tier aliases actually selectable **and routable**. Two coupled
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

- d861650: Add a full interactive `aliases.json` editor to the `/gateway` board (press
  `e`), plus general TUI improvements.

  You can now configure everything from the TUI instead of hand-editing the file:

  - **Backends** — add (from providers pi knows), rename (fallback-chain
    references update automatically), and delete.
  - **Per-backend settings** — `resetSchedule` and `quotaHint` via preset
    pickers, `capStatusCodes` via a text field.
  - **Tiers × models** — for each tier, multi-select and order models from that
    backend's live model list; the ordered selection maps to `heavy-1`,
    `heavy-2`, ….
  - **Fallback chain** — toggle membership and reorder.

  Edits accumulate in an in-memory draft and are only persisted on an explicit
  save (`s`), which validates the whole config, writes atomically (tmp + rename
  under a lockfile, mirroring `gateway-state.json`), then reloads + re-registers.
  Backing out with unsaved changes prompts to discard, so every edit is reversible
  until saved.

  TUI polish: breadcrumb navigation header for nested screens, a `?` help pane,
  scrolling viewports that keep the cursor in view for long lists, type-to-filter
  in pick-lists, and a visual pass (selection markers, healthy/unhealthy and
  selected colors).

  Internals: new `aliases-writer` (raw load + atomic write + pure edit helpers),
  framework-agnostic `tui-widgets` (`ListView`, `TextInput`), and an
  `EditorController` state machine — all unit-tested (186 tests total).

## 0.4.0

### Minor Changes

- a2f7816: Scrub internal/company-specific names from public docs, examples, and code.

  - README, CHANGELOG, and all source doc-comments now use neutral example
    provider names (`openrouter`, `groq`) instead of internal ones.
  - **BREAKING (config):** the shipped `quotaHint` enricher is renamed
    `hai-daily-eur` → `daily-eur-cap`. Update `aliases.json` accordingly. The
    enricher's behavior is unchanged (parses a `DAILY_CAP_EXCEEDED` body with
    `cap_eur`/`spent_eur` fields).
  - Removed the now-dead `backendFamilySuffix` export (family-pinned aliases
    were dropped in 0.3.0) and its tests.
  - Test fixtures use neutral backend/model names.

## 0.3.0

### Minor Changes

- 997e9cd: Indexed, provider-agnostic tier aliases with in-backend model diversity.

  Tier values in `aliases.json` may now be an **ordered list** of model IDs
  (a single string is still accepted and normalized to a 1-element list). Each
  tier emits indexed aliases `<tier>-<N>` (`heavy-1`, `heavy-2`, `light-1`, ...)
  where the index selects the N-th model in the tier's list. This lets a single
  backend expose several distinct models per tier (e.g. `heavy-1` = Claude Opus,
  `heavy-2` = GPT-5.5) behind names that reveal nothing about the backend.

  Changes:

  - **Config:** `backends[name].tiers[slot]` accepts `string | string[]`; empty
    lists are rejected (`cause: "semantic"`).
  - **Indexed emission:** `<tier>-<N>` replaces the single neutral `<tier>-1`.
    The alias count `K` per tier is fixed by the first backend in the chain that
    declares it, so the alias set is stable across cap transitions.
  - **Failover fallthrough:** when the primary backend is capped, `<tier>-N`
    routes into the first healthy backend's list, clamped to its length (high
    indices reuse its last/best model). Availability wins over diversity.
  - **Cap attribution:** now uses a compose-time `alias → backend` routing map
    instead of parsing the alias name (indexed aliases are backend-agnostic).
  - **BREAKING (behavioral):** family-pinned aliases (`heavy-<backend>-1`,
    e.g. `heavy-openrouter-1`, ...) are **removed**. Use `/gateway force <backend>` to
    pin routing to a specific backend.

## 0.2.0

### Minor Changes

- 5ebeb74: Initial release of `@pedro_klein/pi-gateway`.

  Virtual provider extension that exposes stable tier aliases (`heavy-1`,
  `medium-1`, `light-1`, `xlight-1`, `minimal-1`) plus family-pinned variants
  (`heavy-<backend>-1`, ...) routing to already-registered pi
  providers with automatic failover on HTTP 402 / 429 cap hits.

  Features:

  - Declarative `~/.pi/agent/aliases.json` — pure mapping, no duplicated provider settings.
  - Automatic detection of cap hits via `message_end` (with `stopReason: "error"`).
  - Persistent state at `~/.pi/agent/gateway-state.json` with atomic writes + lockfile.
  - Named reset-schedule presets: `utc-midnight`, `utc-monthly-1st`, `utc-hourly`.
  - Optional `quotaHint` enrichers (v1: `daily-eur-cap`) for spend/cap display.
  - Debounced re-registration on state change so multiple simultaneous transitions collapse to one `pi.registerProvider` call.
  - Periodic token refresh (default 30min, configurable via `PI_GATEWAY_OAUTH_REFRESH_MS`) for backends whose auth token changes over time.
  - `/gateway` command with subcommands: `status`, `force <backend>`, `force none`, `clear`, `toggle <backend>`, `reload`.
