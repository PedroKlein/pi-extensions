---
"@pedro_klein/pi-gateway": patch
---

Detect structured Pi and OMP provider failures and retry pre-output capacity, transient HTTP, and network failures through the next healthy backend in the fallback chain. Retries are bounded, preserve per-backend authentication, and stop once semantic output has begun.
