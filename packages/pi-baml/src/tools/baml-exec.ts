import type { BamlError, BamlExecutor, BamlSettings, ModelTier } from "../lib/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { resolveModelTier } from "../lib/bridge.js";
import type { ClientRegistry } from "@boundaryml/baml";

/** Factory type for creating executors. */
export type ExecExecutorFactory = (input: {
  files: Record<string, string>;
  clientRegistry: ClientRegistry;
  syntheticProvider?: string;
}) => BamlExecutor;

/**
 * Create the baml_exec tool.
 *
 * Compiles inline BAML code, resolves the model tier,
 * and executes the specified function.
 */
export function createBamlExecTool(
  settings: BamlSettings,
  executorFactory: ExecExecutorFactory,
): ToolDefinition {
  return {
    async execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
      const code = args["code"] as string;
      const functionName = args["function"] as string;
      const functionArgs = (args["args"] as Record<string, unknown>) ?? {};
      const tier = (args["model"] as ModelTier | undefined) ?? "standard";

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
          files: { "dynamic.baml": code },
          clientRegistry,
          syntheticProvider: bamlProvider,
        });

        const result = await executor.call(functionName, functionArgs);
        executor.dispose();

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
