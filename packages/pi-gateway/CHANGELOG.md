# @pedro_klein/pi-gateway

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
