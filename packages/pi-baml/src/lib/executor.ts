import {
  BamlRuntime,
  ClientRegistry,
  Collector,
} from "@boundaryml/baml";
import {
  BamlClientHttpError,
  BamlValidationError,
  BamlClientFinishReasonError,
} from "@boundaryml/baml";
import type { BamlExecutor, BamlCallMetadata, BamlCallResult, BamlError } from "./types.js";

/** Input for creating a BAML executor. */
export interface CreateExecutorInput {
  /** File contents: filename → BAML source */
  readonly files: Record<string, string>;
  /** Pre-built ClientRegistry with credentials and model configured. */
  readonly clientRegistry: ClientRegistry;
  /** Provider name for the synthetic PiClient block (satisfies BAML compiler). */
  readonly syntheticProvider?: string;
}

/**
 * Build a synthetic `client PiClient { ... }` BAML block.
 *
 * BAML validates all client references at compile time.
 * This placeholder satisfies the compiler; the real credentials
 * are injected via the provided ClientRegistry at runtime.
 */
function buildSyntheticClientBlock(provider: string): string {
  // openai-generic requires base_url at compile time
  const extraOptions = provider === "openai-generic"
    ? '\n    base_url "http://placeholder"'
    : "";
  return `client PiClient {
  provider ${provider}
  options {
    model "placeholder"
    api_key "placeholder"${extraOptions}
  }
}
`;
}

/**
 * Create a BAML executor from file contents and a pre-built ClientRegistry.
 *
 * Compiles the .baml files via BamlRuntime.fromFiles() and
 * returns a minimal BamlExecutor interface.
 *
 * The executor has ZERO model logic — the ClientRegistry is
 * pre-built by the caller (via bridge functions).
 *
 * Throws a structured BamlError on compilation failure.
 */
export function createBamlExecutor(input: CreateExecutorInput): BamlExecutor {
  const { files, clientRegistry, syntheticProvider } = input;

  // Inject synthetic PiClient definition so BAML compiler can resolve it.
  // Uses the provided provider hint or defaults to "anthropic".
  const compilationFiles: Record<string, string> = {
    ...files,
    "__pi_client.baml": buildSyntheticClientBlock(syntheticProvider ?? "anthropic"),
  };

  // Compile the runtime
  let runtime: BamlRuntime;
  try {
    runtime = BamlRuntime.fromFiles("/", compilationFiles, {});
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    const error: BamlError = {
      error: `BAML compilation failed: ${message}`,
      type: "compilation",
      diagnostics: [message],
    };
    throw Object.assign(new Error(error.error), { bamlError: error });
  }

  // Create context manager
  const ctx = runtime.createContextManager();

  // Track disposal state
  let disposed = false;

  return {
    async call<T = unknown>(
      functionName: string,
      args: Record<string, unknown>,
    ): Promise<BamlCallResult<T>> {
      if (disposed) {
        throw new Error(
          "Executor has been disposed. Create a new executor to make calls.",
        );
      }

      const collector = new Collector();

      try {
        const result = await runtime.callFunction(
          functionName,
          args,
          ctx,
          null,
          clientRegistry,
          [collector],
        );

        if (!result.isOk()) {
          const rawOutput = collector.last?.rawLlmResponse ?? null;
          // Try to extract a meaningful error by calling parsed()
          let parseError: string | null = null;
          try {
            result.parsed(false);
          } catch (parseErr) {
            // Use structured BAML error types for better messages
            parseError = extractBamlErrorDetail(parseErr)
              ?? (parseErr instanceof Error ? parseErr.message : String(parseErr));
          }

          const errorMessage = parseError
            ? `BAML execution failed for function '${functionName}': ${parseError}`
            : `BAML execution failed for function '${functionName}'`;

          const error: BamlError = {
            error: errorMessage,
            type: "execution",
            ...(rawOutput !== null && { rawOutput }),
          };
          throw Object.assign(new Error(error.error), { bamlError: error });
        }

        const metadata = extractMetadata(collector);
        return { parsed: result.parsed(false) as T, metadata };
      } catch (err) {
        // Re-throw if already a BamlError
        if (
          err instanceof Error &&
          "bamlError" in err
        ) {
          throw err;
        }

        // Extract structured info from BAML's typed errors
        const rawOutput = collector.last?.rawLlmResponse ?? null;
        const errorDetail = extractBamlErrorDetail(err);

        const message =
          errorDetail ?? (err instanceof Error ? err.message : String(err));
        const error: BamlError = {
          error: `BAML execution failed for function '${functionName}': ${message}`,
          type: "execution",
          ...(rawOutput !== null && { rawOutput }),
        };
        throw Object.assign(new Error(error.error), { bamlError: error });
      }
    },

    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * Extract execution metadata from BAML's Collector.
 *
 * Reads token usage, timing, and model info from the last function log.
 */
function extractMetadata(collector: Collector): BamlCallMetadata {
  const last = collector.last;
  if (!last) {
    return {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      durationMs: null,
      model: null,
    };
  }

  const usage = last.usage;
  const timing = last.timing;

  // Try to get model/client name from the selected call
  let model: string | null = null;
  try {
    const selected = last.selectedCall as { clientName?: string } | null;
    if (selected && typeof selected === "object" && "clientName" in selected) {
      model = (selected as { clientName: string }).clientName ?? null;
    }
  } catch {
    // selectedCall may not be available in all BAML versions
  }

  // cachedInputTokens may not exist in older BAML versions
  let cachedInputTokens: number | null = null;
  try {
    const usageAny = usage as unknown as { cachedInputTokens?: number | null };
    if ("cachedInputTokens" in usageAny && usageAny.cachedInputTokens != null) {
      cachedInputTokens = usageAny.cachedInputTokens;
    }
  } catch {
    // Property doesn't exist in this version
  }

  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens,
    durationMs: timing?.durationMs ?? null,
    model,
  };
}

/**
 * Extract a human-readable error detail from BAML's typed error classes.
 *
 * BAML throws BamlClientHttpError (HTTP failures), BamlValidationError
 * (output parse failures), and BamlClientFinishReasonError (truncated responses).
 * This extracts the structured fields into a single message.
 */
function extractBamlErrorDetail(err: unknown): string | null {
  if (!(err instanceof Error)) return null;

  // HTTP-level failure (401, 429, 500, connection refused, etc.)
  const httpErr = BamlClientHttpError.from(err);
  if (httpErr) {
    return `HTTP ${httpErr.status_code} from client "${httpErr.client_name}": ${httpErr.message}`;
  }

  // Output validation failure (LLM responded but output doesn't match schema)
  const validationErr = BamlValidationError.from(err);
  if (validationErr) {
    return `Output validation failed: ${validationErr.message}\nRaw output: ${validationErr.raw_output}`;
  }

  // Finish reason error (response truncated, content filter, etc.)
  const finishErr = BamlClientFinishReasonError.from(err);
  if (finishErr) {
    return `LLM finish reason error${finishErr.finish_reason ? ` (${finishErr.finish_reason})` : ""}: ${finishErr.message}`;
  }

  return null;
}
