# pi-audit

`pi-audit` records prompt/tool fingerprints, context health, and model usage from extensions without adding model-visible tools, messages, skills, or prompt text.

## Usage event contract

Emit usage on the shared event bus:

```ts
pi.events.emit("pi-audit:usage", {
  source: "example-extension",
  operation: "background-review",
  model: "custom-provider/example-model",
  input: 120,
  cacheRead: 40,
  cacheWrite: 10,
  output: 25,
  reasoning: 5,
  durationMs: 800,
  trigger: "automatic",
  status: "complete",
});
```

### Required fields

| Field | Type | Meaning |
|---|---|---|
| `source` | `string` | Stable extension or subsystem identifier. |
| `operation` | `string` | Stable operation identifier. Lifecycle operations conventionally end in `-start`, `-complete`, or `-error`. |
| `model` | `string` | Provider/model route used by the call, or `unknown` when unavailable. |
| `input` | non-negative number | Input tokens. Use `0` when the lifecycle event has no usage yet. |
| `cacheRead` | non-negative number | Cache-read tokens. |
| `cacheWrite` | non-negative number | Cache-write tokens. |
| `output` | non-negative number | Output tokens. |
| `reasoning` | non-negative number | Reasoning tokens. |
| `durationMs` | non-negative number | Elapsed milliseconds. |
| `trigger` | `automatic` or `user` | Whether a background/system action or an explicit user action caused the call. |
| `status` | `start`, `complete`, or `error` | Call lifecycle state. |

### Retry attribution

Retry events also carry:

| Field | Type | Meaning |
|---|---|---|
| `retryLayer` | `core`, `gateway`, or `malformed-tool` | Layer that initiated the retry. |
| `attempt` | positive integer | One-based retry attempt within that layer. |
| `route` | `string` | Model route or backend transition, such as `backend-a->backend-b`. |

Emit `pi-audit:retry-scheduled` before an extension-owned follow-up retry. This prevents the audit extension from also classifying the same run as a core retry.

### Third-party watchdog reviews

A watchdog or reviewer package that performs an automatic model call must emit the same lifecycle contract:

- `source`: a stable package identifier such as `pi-subagents`;
- `operation`: `watchdog-review-start`, `watchdog-review-complete`, or `watchdog-review-error`;
- `trigger`: `automatic`;
- `status`: the matching `start`, `complete`, or `error` value;
- the actual model, token categories, and duration when available.

The watchdog remains responsible for emitting these events; `pi-audit` does not patch or wrap third-party package code. Missing or malformed events are ignored rather than entering model context.

Invalid or incomplete events are ignored. Automatic lifecycle events produce compact UI notices and remain outside model context. `/audit-usage` prints totals, source aggregates, and every recorded event.
