import type { FunctionsRegistry } from "../lib/registry.js";
import type { BamlError, BamlExecutor, BamlSettings, FunctionEntry, ModelTier } from "../lib/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { resolveModelTier } from "../lib/bridge.js";
import type { ClientRegistry } from "@boundaryml/baml";

/** Factory type for creating executors. */
export type ExecutorFactory = (input: {
  files: Record<string, string>;
  clientRegistry: ClientRegistry;
  syntheticProvider?: string;
}) => BamlExecutor;

/**
 * Create the baml_run tool.
 *
 * Resolves a function from the registry, resolves the model tier,
 * creates an executor, and calls the function.
 */
export function createBamlRunTool(
  registry: FunctionsRegistry,
  executorFactory: ExecutorFactory,
  settings: BamlSettings,
): ToolDefinition {
  return {
    async execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
      const functionName = args["function"] as string;
      const functionArgs = (args["args"] as Record<string, unknown>) ?? {};
      const tier = (args["model"] as ModelTier | undefined) ?? "standard";

      // Resolve function from registry
      let entry: FunctionEntry;
      try {
        entry = registry.resolve(functionName);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err), "configuration");
      }

      // Resolve model tier
      if (!ctx?.modelRegistry) {
        return errorResult("No modelRegistry available. Session must be started.", "configuration");
      }

      let clientRegistry: ClientRegistry;
      let bamlProvider: string;
      try {
        const resolved = await resolveModelTier(settings, ctx.modelRegistry, tier);
        clientRegistry = resolved.clientRegistry;
        bamlProvider = resolved.bamlProvider;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err), "configuration");
      }

      // Create executor and call function
      const modelRef = settings.models[tier];
      try {
        const executor = executorFactory({
          files: entry.files,
          clientRegistry,
          syntheticProvider: bamlProvider,
        });

        const result = await executor.call(entry.name, functionArgs);
        return {
          content: [{ type: "text", text: JSON.stringify({ result: result.parsed, model: modelRef, tier }) }],
          details: { metadata: result.metadata },
        };
      } catch (err) {
        if (err instanceof Error && "bamlError" in err) {
          const bamlError = (err as Error & { bamlError: BamlError }).bamlError;
          return { content: [{ type: "text", text: JSON.stringify(bamlError) }], details: undefined };
        }
        return errorResult(err instanceof Error ? err.message : String(err), "execution");
      }
    },
  };
}

function errorResult(message: string, type: BamlError["type"]): ToolResult {
  const error: BamlError = { error: message, type };
  return { content: [{ type: "text", text: JSON.stringify(error) }], details: undefined };
}
