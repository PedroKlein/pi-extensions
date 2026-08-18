---
"@pedro_klein/pi-gateway": patch
---

Fix "Unknown type" crash on oh-my-pi session start. oh-my-pi's extension loader
redirects the bare `@sinclair/typebox` root import to its omptype TypeBox facade
but leaves subpaths on real typebox, so mixing facade-built schemas (`Type`)
with the real `@sinclair/typebox/value` checker (`Value`) threw "Unknown type"
during config/state validation. Import `Type` from the `@sinclair/typebox/type`
subpath so `Type` and `Value` resolve to the same (real) typebox on both
harnesses. Added a regression guard asserting no runtime import uses the bare
root specifier.
