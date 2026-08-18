---
"@pedro_klein/pi-gateway": minor
---

Add a full interactive `aliases.json` editor to the `/gateway` board (press
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
