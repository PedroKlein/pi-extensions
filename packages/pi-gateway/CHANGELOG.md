# @pedro_klein/pi-gateway

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
  - **BREAKING (behavioral):** family-pinned aliases (`heavy-hai-1`,
    `heavy-copilot-1`, ...) are **removed**. Use `/gateway force <backend>` to
    pin routing to a specific backend.

## 0.2.0

### Minor Changes

- 5ebeb74: Initial release of `@pedro_klein/pi-gateway`.

  Virtual provider extension that exposes stable tier aliases (`heavy-1`,
  `medium-1`, `light-1`, `xlight-1`, `minimal-1`) plus family-pinned variants
  (`heavy-hai-1`, `heavy-copilot-1`, ...) routing to already-registered pi
  providers with automatic failover on HTTP 402 / 429 cap hits.

  Features:

  - Declarative `~/.pi/agent/aliases.json` — pure mapping, no duplicated provider settings.
  - Automatic detection of cap hits via `message_end` (with `stopReason: "error"`).
  - Persistent state at `~/.pi/agent/gateway-state.json` with atomic writes + lockfile.
  - Named reset-schedule presets: `utc-midnight`, `utc-monthly-1st`, `utc-hourly`.
  - Optional `quotaHint` enrichers (v1: `hai-daily-eur`) for spend/cap display.
  - Debounced re-registration on state change so multiple simultaneous transitions collapse to one `pi.registerProvider` call.
  - Periodic token refresh (default 30min, configurable via `PI_GATEWAY_OAUTH_REFRESH_MS`) for backends whose auth token changes over time.
  - `/gateway` command with subcommands: `status`, `force <backend>`, `force none`, `clear`, `toggle <backend>`, `reload`.
