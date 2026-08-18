---
"@pedro_klein/pi-gateway": minor
---

Add oh-my-pi (`@oh-my-pi/pi-coding-agent`) support alongside pi.

The extension now ships two entry points that share one runtime, config,
editor, and routing core:

- `pi.extensions` → `./src/index.ts` (pi / `@earendil-works`)
- `omp.extensions` → `./src/omp.ts` (oh-my-pi / `@oh-my-pi`)

Only the two harness seams differ, behind injectable adapters:

- **Transport** — a new harness-agnostic `transport-core` (`createGatewayTransport({ registerApi, deliver })`) maps a stable alias to its real backend model at request time. pi wires it to `@earendil-works/pi-ai/compat` (`registerApiProvider` + `getApiProvider`); oh-my-pi wires it to `@oh-my-pi/pi-ai` (`registerCustomApi` + top-level `stream`/`streamSimple`, which route both custom and builtin backend apis).
- **Provider registration** — pi keeps per-model `api`/`baseUrl`; oh-my-pi uses a provider-level `baseUrl` (it has no per-model `baseUrl`) drawn from the single effective backend, and receives the credential literally (no pi config-value `$`/`!` escaping).

No behavior change for pi users. The credential-escaping step moved from the
shared session pipeline into the pi register adapter (unchanged pi output).
