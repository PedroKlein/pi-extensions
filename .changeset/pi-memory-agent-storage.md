---
"@pedro_klein/pi-memory": patch
---

Separate default memory storage by Pi agent directory while preserving the standard agent's existing database and trusted project overrides. Add explicit SDK factory configuration, startup storage diagnostics, fail-closed initialization, and bounded concurrent SQLite startup with legacy-database and real multi-process regression tests.
