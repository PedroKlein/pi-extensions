# pi-baml

Typed structured output from LLMs for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Connects [BAML](https://github.com/BoundaryML/baml) (a DSL for defining typed LLM functions) to Pi's provider system, so the agent and extensions get schema-validated responses without manual JSON parsing.

## How it works

pi-baml registers three tools (`baml_list`, `baml_run`, `baml_exec`) and injects an `<available_baml_functions>` block into the system prompt, following the same pattern Pi uses for `<available_skills>`. The agent sees what functions exist, calls `baml_list` to get signatures, and calls `baml_run` to execute them.

Functions live in `.baml` files organized into groups (directories). Groups are discovered from standard paths at startup and compiled on demand at call time. Credentials come from Pi's ModelRegistry; there's no separate API key management.

The package also ships a bundled **BAML authoring skill** (`skills/baml/`) that teaches the agent how to write correct BAML code for `baml_exec`.

## Installation

```bash
pi install https://github.com/PedroKlein/pi-baml
```

Or pin to a release:

```bash
pi install https://github.com/PedroKlein/pi-baml@v0.1.0
```

Pi clones the repo, installs dependencies, and builds automatically.

## Configuration

Add a `baml` section to `~/.pi/agent/settings.json`:

```json
{
  "baml": {
    "models": {
      "light": "github-copilot/claude-haiku-4.5",
      "standard": "github-copilot/claude-sonnet-4.6",
      "heavy": "hai-proxy/anthropic--claude-4.6-opus"
    }
  }
}
```

Three model tiers map to provider/model pairs from Pi's model registry (`pi --list-models`):

| Tier | When to use | Typical model class |
|------|-------------|---------------------|
| `light` | Simple classification, formatting, yes/no | haiku |
| `standard` | Most tasks: extraction, multi-field output (default) | sonnet |
| `heavy` | Complex reasoning, ambiguous inputs | opus |

See [docs/configuration.md](docs/configuration.md) for the full reference, including supported API types and provider-specific notes.

### Optional settings

| Key | Default | Description |
|-----|---------|-------------|
| `systemPrompt` | `true` | Inject `<available_baml_functions>` into the system prompt |
| `functionsDirs` | `[]` | Extra directories to scan for function groups |

## Function discovery

Groups are discovered from these directories (lowest to highest priority):

| Priority | Path | Notes |
|----------|------|-------|
| 1 (lowest) | Pi's resolved skill paths | Skill-colocated, prefixed `skill:`, discovered lazily |
| 2 | `~/.agents/baml/<group>/` | Shared across agents |
| 3 | `~/.pi/baml/<group>/` | User Pi-local |
| 4 | `[functionsDirs]` | From settings |
| 5 | `<cwd>/.pi/baml/<group>/` | Project Pi-local |
| 6 (highest) | `<cwd>/.agents/baml/<group>/` | Project-specific |

Higher priority wins when names collide. Each subdirectory is one compilation unit.

Skill-colocated BAML is discovered lazily on the first agent turn using Pi's resolved skill paths — this automatically works with any profile, including custom `--skill` flags and npm-packaged skills.

### System prompt injection

When `systemPrompt` is enabled, pi-baml appends an XML block to the system prompt listing all non-skill groups:

```xml
<available_baml_functions>
BAML function groups callable via the baml_run tool.
Call baml_list with a group name to see function signatures and types before invoking.

  <group>
    <name>extract-todos</name>
    <description>Extract TODO items from freeform text.</description>
  </group>
</available_baml_functions>
```

`skill:*` groups are excluded from this block. They're internal to their owning skill and documented in its SKILL.md instead.

### Adding descriptions

Add a `README.md` with frontmatter to any group directory:

```markdown
---
description: Extract TODO items from freeform text.
---

# Extract TODOs

Additional documentation shown when the agent calls baml_list(group).
```

The `description` field appears in the system prompt. The README body shows up in `baml_list` detail output. README.md is never compiled (only `.baml` files go to the BAML runtime).

## Tools

| Tool | Purpose |
|------|---------|
| `baml_list` | Browse groups and get function signatures |
| `baml_run` | Execute a pre-defined function by name |
| `baml_exec` | Compile and execute inline BAML code |

All three accept an optional `model` parameter: `"light"`, `"standard"`, or `"heavy"` (default: `"standard"`).

Output includes the resolved model and tier:

```json
{
  "result": [{"task": "Buy milk", "priority": "low"}],
  "model": "github-copilot/claude-haiku-4.5",
  "tier": "light"
}
```

## Writing .baml files

```baml
class ActionItem {
  description string @description("what needs to be done")
  assignee string? @description("who is responsible, if mentioned")
  priority "high" | "medium" | "low"
}

function ExtractActionItems(meeting_notes: string) -> ActionItem[] {
  client PiClient
  prompt #"
    Extract action items from these meeting notes.

    {{ ctx.output_format }}

    ---
    {{ meeting_notes }}
  "#
}
```

Two rules:
1. Always use `client PiClient`. The real model is selected at call time via the tier system.
2. Always include `{{ ctx.output_format }}` in the prompt so BAML can inject its schema instructions.

## Skill integration

Skills can bundle their own `.baml` files for deterministic processing. Two layouts are supported:

**Dedicated subdirectory** (preferred for multiple files):
```
skills/
  my-skill/
    SKILL.md
    baml/
      classify.baml
      README.md
```

**Flat layout** (convenient for single-file schemas):
```
skills/
  my-skill/
    SKILL.md
    schema.baml
```

If both a `baml/` subdirectory and flat `.baml` files exist, the subdirectory takes precedence.

These register with a `skill:` prefix (e.g. `skill:my-skill`) and are callable via `baml_run("skill:my-skill/ClassifyInput", {...})`. They are discovered lazily on the first agent turn using Pi's resolved skill paths — automatically working with any profile configuration. They are excluded from the system prompt. The skill's own SKILL.md documents when and how to call them.

This keeps skill-specific BAML self-contained alongside the skill that uses it, rather than polluting the global function namespace.

## EventBus API (for extension authors)

Other Pi extensions can consume pi-baml programmatically:

```typescript
let baml: PiBamlLibrary | null = null;

pi.events.on("pi-baml:ready", (lib) => {
  baml = lib as PiBamlLibrary;
});

pi.on("session_start", async (event, ctx) => {
  if (!baml?.available) return;

  // One-shot: compile and execute inline BAML
  const items = await baml.execBaml(
    classifyBamlSource,
    "ClassifySkill",
    { prompt: userMessage, skills: skillList },
    ctx.modelRegistry,
    "light",
  );

  // Execute a registered function by name
  const todos = await baml.call(
    "ExtractTodos",
    { notes: meetingNotes },
    ctx.modelRegistry,
    "heavy",
  );

  // Create a reusable executor from in-memory files
  const executor = await baml.createExecutor(
    { "main.baml": bamlSource },
    ctx.modelRegistry,
    "standard",
  );
  const result = await executor.call("MyFunc", { input: "..." });
});
```

Key points:
- The library fires on the EventBus during factory phase (no `session_start` dependency).
- Every method takes `modelRegistry` as a parameter. No internal state, no ordering issues.
- If pi-baml isn't installed, `pi-baml:ready` never fires. Extensions should fall back gracefully.

## Bundled skill

The package includes a BAML authoring skill at `skills/baml/`. When installed, it appears in the agent's available skills and provides guidance on BAML's type system, prompt patterns, and pi-baml conventions. The agent loads it automatically when writing dynamic BAML for `baml_exec`.

Declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["dist/index.js"],
    "skills": ["skills/baml"]
  }
}
```

## Development

```bash
npm install
npm run build          # tsup -> dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src/ tests/
npm test               # vitest (unit tests)
npm run test:integration  # real BAML compilation
```

Integration tests with live LLM calls:

```bash
PI_BAML_TEST_PROXY_URL=http://localhost:6655 npm run test:integration
```

## License

MIT
