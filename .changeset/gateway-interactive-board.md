---
"@pedro_klein/pi-gateway": minor
---

Add an interactive `/gateway` board and a `/gateway models` view.

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
