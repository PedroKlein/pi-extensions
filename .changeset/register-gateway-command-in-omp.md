---
"@pedro_klein/pi-gateway": patch
---

Register `/gateway` during extension load so oh-my-pi includes the command and its interactive TUI. Previously it was registered after `session_start`, which is too late for oh-my-pi's extension registration snapshot.
