/**
 * pi-baml shared types.
 *
 * No runtime logic — only interfaces, types, and type-level constants.
 */

// ─── Configuration Types ─────────────────────────────────────────────────────

/** Model tier for selecting which configured model to use. */
export type ModelTier = "light" | "standard" | "heavy";

/** Model configuration: maps each tier to a "provider/model-id" string. */
export interface ModelTierConfig {
  readonly light: string;
  readonly standard: string;
  readonly heavy: string;
}

/** The complete baml section from Pi's settings.json. */
export interface BamlSettings {
  /** Model tier configuration */
  readonly models: ModelTierConfig;
  /** Additional directories to scan for .baml function files */
  readonly functionsDirs?: readonly string[];
  /** Whether to inject available functions into system prompt (default: true) */
  readonly systemPrompt?: boolean;
}

// ─── Executor Types ──────────────────────────────────────────────────────────

/** Metadata captured from BAML's Collector after a function call. */
export interface BamlCallMetadata {
  /** Number of input tokens consumed (null if provider didn't report) */
  readonly inputTokens: number | null;
  /** Number of output tokens generated (null if provider didn't report) */
  readonly outputTokens: number | null;
  /** Number of cached input tokens (null if not applicable) */
  readonly cachedInputTokens: number | null;
  /** Wall-clock duration of the LLM call in milliseconds (null if unavailable) */
  readonly durationMs: number | null;
  /** Model/client name used for the call (null if unavailable) */
  readonly model: string | null;
}

/** Result of a BAML function call including parsed output and execution metadata. */
export interface BamlCallResult<T = unknown> {
  /** The parsed, typed output from the BAML function */
  readonly parsed: T;
  /** Execution metadata (tokens, timing, model) */
  readonly metadata: BamlCallMetadata;
}

/**
 * Minimal interface for executing BAML functions.
 *
 * Deep module: small interface hiding BamlRuntime complexity.
 */
export interface BamlExecutor {
  /** Execute a named function with arguments, returning parsed typed output with metadata. */
  call<T = unknown>(
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<BamlCallResult<T>>;

  /** Release resources. Safe to call multiple times. */
  dispose(): void;
}

// ─── Registry Types ──────────────────────────────────────────────────────────

/** Internal representation of a discovered BAML function. */
export interface FunctionEntry {
  /** Function name as declared in .baml source */
  readonly name: string;
  /** Group name (subdirectory name) */
  readonly group: string;
  /** File contents of the compilation unit: filename → source */
  readonly files: Readonly<Record<string, string>>;
  /** Raw input parameter signature, e.g. "text: string, count: int" */
  readonly inputTypes: string;
  /** Raw output type, e.g. "ActionItem[]" */
  readonly outputType: string;
  /** Human-readable description from README.md frontmatter */
  readonly description?: string;
}

/** Public-facing function metadata for baml_list. */
export interface FunctionInfo {
  /** Function name */
  readonly name: string;
  /** Group (subdirectory) this function belongs to */
  readonly group: string;
  /** Qualified name: "group/name" */
  readonly qualifiedName: string;
  /** Input parameters signature */
  readonly inputTypes: string;
  /** Output type */
  readonly outputType: string;
  /** Human-readable description from README.md frontmatter */
  readonly description?: string;
}

/** Compact group summary for unfiltered baml_list output. */
export interface GroupInfo {
  readonly name: string;
  readonly description?: string;
  readonly functions: readonly string[];
}

/** Full group detail for filtered baml_list output. */
export interface GroupDetail {
  readonly group: string;
  readonly description?: string;
  readonly readme?: string;
  readonly types: readonly string[];
  readonly functions: readonly FunctionInfo[];
}

// ─── Error Types ─────────────────────────────────────────────────────────────

/** Discriminated error type for BAML operations. */
export type BamlErrorType =
  | "compilation"
  | "execution"
  | "configuration"
  | "unavailable";

/** Structured error returned from tools and library methods. */
export interface BamlError {
  /** Human-readable error message */
  readonly error: string;
  /** Error category */
  readonly type: BamlErrorType;
  /** Raw LLM response text (execution errors only) */
  readonly rawOutput?: string;
  /** BAML compiler diagnostics (compilation errors only) */
  readonly diagnostics?: readonly string[];
}

// ─── ModelRegistry Type ──────────────────────────────────────────────────────

/** Model lookup and auth resolution interface (subset of Pi's ModelRegistry). */
export interface ModelRegistry {
  find(provider: string, modelId: string): {
    id: string;
    provider: string;
    api: string;
    baseUrl: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  } | undefined;
  getApiKeyAndHeaders(model: { provider: string; [key: string]: unknown }): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } |
    { ok: false; error: string }
  >;
}

// ─── EventBus Library API ────────────────────────────────────────────────────

/**
 * The public API shape emitted via pi.events on "pi-baml:ready".
 *
 * All methods that interact with LLMs require a ModelRegistry parameter.
 * Callers pass their own ctx.modelRegistry — no internal state or lifecycle coupling.
 */
export interface PiBamlLibrary {
  /** Whether the BAML runtime loaded successfully */
  readonly available: boolean;

  /** Create executor from in-memory .baml file contents */
  createExecutor(
    files: Record<string, string>,
    modelRegistry: ModelRegistry,
    tier?: ModelTier,
  ): Promise<BamlExecutor>;

  /** One-shot: compile + execute dynamic BAML code */
  execBaml<T = unknown>(
    code: string,
    fn: string,
    args: Record<string, unknown>,
    modelRegistry: ModelRegistry,
    tier?: ModelTier,
  ): Promise<T>;

  /** Call a registered function by name (from the registry) */
  call<T = unknown>(
    fn: string,
    args: Record<string, unknown>,
    modelRegistry: ModelRegistry,
    tier?: ModelTier,
  ): Promise<T>;

  /** List all discovered functions */
  list(group?: string): FunctionInfo[];
}
