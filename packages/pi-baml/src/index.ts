import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseBamlSettings } from "./lib/config.js";
import { FunctionsRegistry } from "./lib/registry.js";
import { discoverBamlGroups, scanSkillDirectories } from "./lib/discovery.js";
import { createPiBamlLibrary, type PiBamlLibraryInternal } from "./eventbus.js";
import { createBamlListTool } from "./tools/baml-list.js";
import { createBamlRunTool } from "./tools/baml-run.js";
import { createBamlExecTool } from "./tools/baml-exec.js";
import { createBamlExecutor } from "./lib/executor.js";
import { renderBamlSystemPrompt } from "./lib/system-prompt.js";
import {
  renderBamlExecCall,
  renderBamlRunCall,
  renderBamlListCall,
  renderBamlResult,
  renderBamlListResult,
} from "./tools/render.js";
import type { BamlError } from "./lib/types.js";
import type { ToolContext, ToolResult } from "./tools/types.js";

/** Text component constructor type for tool rendering. */
type TextConstructor = new (text: string, px: number, py: number) => unknown;
let textClassPromise: Promise<TextConstructor | null> | undefined;

function getTextClass(): Promise<TextConstructor | null> {
  if (!textClassPromise) {
    textClassPromise = import("@earendil-works/pi-tui")
      .then((tui) => (tui as { Text: TextConstructor }).Text)
      .catch(() => null);
  }
  return textClassPromise;
}

let resolvedTextClass: TextConstructor | null | undefined;
getTextClass().then((cls) => { resolvedTextClass = cls; });

function createTextComponent(text: string): unknown {
  if (resolvedTextClass) {
    return new resolvedTextClass(text, 0, 0);
  }
  return { render(_width: number) { return text.split("\n"); } };
}

/** Options for testing. */
export interface ExtensionOptions {
  bamlAvailable?: boolean;
  loadError?: string;
  settings?: unknown;
  cwd?: string;
}

/** Minimal Pi extension API subset we depend on. */
interface PiExtensionAPI {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (...args: unknown[]) => Promise<ToolResult>;
    renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
    renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
  }): void;
  events: {
    emit(event: string, payload: unknown): void;
  };
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

function readSettingsFromDisk(): unknown {
  try {
    return JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * pi-baml extension factory.
 *
 * Registers baml_list, baml_run, baml_exec tools.
 * Emits "pi-baml:ready" on EventBus.
 * Captures ModelRegistry on session_start.
 */
export function createPiBamlExtension(
  pi: PiExtensionAPI,
  options?: ExtensionOptions,
): void {
  // Suppress BAML's INFO logging
  try {
    import("@boundaryml/baml").then(({ setLogLevel }) => {
      setLogLevel("warn");
    }).catch(() => {});
  } catch { /* ignore */ }

  const bamlAvailable = options?.bamlAvailable ?? true;
  const loadError = options?.loadError;

  // Parse settings
  const rawSettings = options?.settings !== undefined ? options.settings : readSettingsFromDisk();
  let settings;
  try {
    settings = parseBamlSettings(rawSettings);
  } catch (err) {
    // Emit unavailable library if settings are broken
    const errMsg = err instanceof Error ? err.message : String(err);
    const lib = createPiBamlLibrary({ available: false, loadError: errMsg, settings: { models: { light: "", standard: "", heavy: "" } } });
    pi.events.emit("pi-baml:ready", lib);
    return;
  }

  const lib: PiBamlLibraryInternal = createPiBamlLibrary({
    available: bamlAvailable,
    ...(loadError !== undefined && { loadError }),
    settings,
  });

  // Discover functions (skip skill dirs — those are discovered lazily from before_agent_start)
  const cwd = options?.cwd ?? process.cwd();
  const discoveredGroups = discoverBamlGroups(cwd, settings.functionsDirs, []);
  const registry = FunctionsRegistry.fromGroups(discoveredGroups);
  lib.setRegistry(registry);

  // Emit on EventBus
  pi.events.emit("pi-baml:ready", lib);

  // System prompt injection — computed once, handler appends the cached block.
  // Also performs one-time lazy skill-BAML discovery from Pi's resolved skill paths.
  const systemPromptBlock = settings.systemPrompt !== false ? renderBamlSystemPrompt(registry) : null;
  let skillsDiscovered = false;

  pi.on("before_agent_start", async (...args: unknown[]) => {
    const event = args[0] as {
      systemPrompt?: string;
      systemPromptOptions?: { skills?: Array<{ baseDir: string; name: string }> };
    };

    // One-time lazy skill-BAML discovery from Pi's resolved skill paths
    if (!skillsDiscovered) {
      skillsDiscovered = true;
      const skills = event?.systemPromptOptions?.skills;
      if (skills?.length) {
        const skillDirs = deriveSkillDirs(skills);
        for (const dir of skillDirs) {
          const groups = scanSkillDirectories(dir);
          registry.mergeGroups(groups);
        }
      }
    }

    if (systemPromptBlock !== null) {
      return { systemPrompt: (event?.systemPrompt ?? "") + "\n\n" + systemPromptBlock };
    }
  });

  // Executor factory
  function toolExecutorFactory(input: {
    files: Record<string, string>;
    clientRegistry: import("@boundaryml/baml").ClientRegistry;
    syntheticProvider?: string;
  }) {
    if (!bamlAvailable) {
      throw Object.assign(
        new Error(`pi-baml: BAML runtime unavailable: ${loadError ?? "unknown"}`),
        { bamlError: { error: `pi-baml: BAML runtime unavailable: ${loadError ?? "unknown"}`, type: "unavailable" as const } satisfies BamlError },
      );
    }
    return createBamlExecutor({
      files: input.files,
      clientRegistry: input.clientRegistry,
      ...(input.syntheticProvider !== undefined && { syntheticProvider: input.syntheticProvider }),
    });
  }

  function extractToolContext(piArgs: unknown[]): ToolContext | undefined {
    const ctx = piArgs[4] as Record<string, unknown> | undefined;
    if (!ctx) return undefined;
    const modelRegistry = ctx["modelRegistry"] as ToolContext["modelRegistry"] | undefined;
    return { modelRegistry };
  }

  // Register tools
  const listTool = createBamlListTool(registry);
  pi.registerTool({
    name: "baml_list",
    description: "List available BAML functions from the registry. Without a group filter: returns a compact index of all groups with names, descriptions, and function names. With a group filter: returns full detail including README documentation, type definitions, and function signatures — everything needed to construct a baml_run call.",
    parameters: {
      type: "object",
      properties: {
        group: { type: "string", description: "Filter by group name (optional)" },
      },
    },
    execute: (...piArgs: unknown[]) => {
      const params = (piArgs[1] ?? piArgs[0] ?? {}) as Record<string, unknown>;
      return listTool.execute(params);
    },
    renderCall(args: unknown, theme: unknown) {
      const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
      return createTextComponent(renderBamlListCall((args ?? {}) as Record<string, unknown>, t));
    },
    renderResult(result: unknown, options: unknown, theme: unknown) {
      const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
      const r = result as { content: { type: string; text?: string }[]; details?: unknown };
      const opts = options as { isPartial?: boolean };
      return createTextComponent(renderBamlListResult(r, t, opts.isPartial));
    },
  });

  const runTool = createBamlRunTool(registry, toolExecutorFactory, settings);
  pi.registerTool({
    name: "baml_run",
    description: "Execute a pre-defined BAML function by name from the registry. Returns typed structured output.",
    parameters: {
      type: "object",
      properties: {
        function: { type: "string", description: "Function name (or group/name if ambiguous)" },
        args: { type: "object", description: "Function arguments as key-value pairs" },
        model: { type: "string", description: "Optional model override (e.g. 'anthropic/claude-4.5-sonnet')" },
      },
      required: ["function", "args"],
    },
    execute: (...piArgs: unknown[]) => {
      const params = (piArgs[1] ?? piArgs[0] ?? {}) as Record<string, unknown>;
      const ctx = extractToolContext(piArgs);
      return runTool.execute(params, ctx);
    },
    renderCall(args: unknown, theme: unknown) {
      const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
      return createTextComponent(renderBamlRunCall((args ?? {}) as Record<string, unknown>, t));
    },
    renderResult(result: unknown, options: unknown, theme: unknown) {
      const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
      const r = result as { content: { type: string; text?: string }[]; details?: unknown };
      const opts = options as { isPartial?: boolean };
      return createTextComponent(renderBamlResult(r, t, opts.isPartial));
    },
  });

  const execTool = createBamlExecTool(settings, toolExecutorFactory);
  pi.registerTool({
    name: "baml_exec",
    description: "Compile and execute inline BAML code. Use for dynamic structured extraction/classification. Always use 'client PiClient' in your code.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "BAML source code defining at least one function" },
        function: { type: "string", description: "Function name to call from the provided code" },
        args: { type: "object", description: "Function arguments as key-value pairs" },
        model: { type: "string", description: "Model tier override: 'light', 'standard', or 'heavy' (default: standard)" },
      },
      required: ["code", "function", "args"],
    },
    execute: (...piArgs: unknown[]) => {
      const params = (piArgs[1] ?? piArgs[0] ?? {}) as Record<string, unknown>;
      const ctx = extractToolContext(piArgs);
      return execTool.execute(params, ctx);
    },
    renderCall(args: unknown, theme: unknown) {
      const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
      return createTextComponent(renderBamlExecCall((args ?? {}) as Record<string, unknown>, t));
    },
    renderResult(result: unknown, options: unknown, theme: unknown) {
      const t = theme as { fg(c: string, s: string): string; bold(s: string): string };
      const r = result as { content: { type: string; text?: string }[]; details?: unknown };
      const opts = options as { isPartial?: boolean };
      return createTextComponent(renderBamlResult(r, t, opts.isPartial));
    },
  });

}

/**
 * Derive unique parent directories from Pi's resolved skill paths.
 *
 * Each skill's baseDir is like `/path/to/skills/diagnose`.
 * We want the parent (`/path/to/skills/`) so we can scan for
 * sibling skills that may have `baml/` subdirectories.
 */
function deriveSkillDirs(skills: Array<{ baseDir: string }>): string[] {
  const dirs = new Set<string>();
  for (const skill of skills) {
    if (skill.baseDir) {
      dirs.add(dirname(skill.baseDir));
    }
  }
  return [...dirs];
}

export default createPiBamlExtension;
