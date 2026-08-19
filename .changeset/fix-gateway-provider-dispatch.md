---
"@pedro_klein/pi-gateway": patch
---

Route gateway aliases through each registered backend provider with that backend's resolved authentication, headers, base URL, and environment. This preserves provider-specific request behavior and supports custom transports without requiring a separate global API registration. Gateway model display names now include the active backend, for example `Example Model (backend-a)`.
