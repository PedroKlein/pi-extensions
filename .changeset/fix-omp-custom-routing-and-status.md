---
"@pedro_klein/pi-gateway": patch
---

Route OMP gateway aliases through extension-defined custom API transports announced over the shared event bus, avoiding OMP's isolated extension-side API registry. Re-select the active gateway alias after every successful re-registration so the status bar immediately reflects backend and model changes.
