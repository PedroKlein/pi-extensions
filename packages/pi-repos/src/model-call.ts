import type {
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

export interface ModelUsageEvent {
  source: string;
  operation: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: number;
  durationMs: number;
  trigger: "automatic" | "user";
  status: "complete" | "error";
  route?: string;
}

export interface ModelCallRequest {
  model?: string;
  systemPrompt: string;
  prompt: string;
  operation: string;
  trigger?: "automatic" | "user";
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export type ModelCall = (request: ModelCallRequest) => Promise<string | null>;

type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry">;
type ChatModel = ReturnType<ModelRegistry["getAll"]>[number];
type ModelResponse = Awaited<ReturnType<ReturnType<ModelRegistry["streamSimple"]>["result"]>>;
type StreamOptions = NonNullable<Parameters<ModelRegistry["streamSimple"]>[2]>;
type ReasoningLevel = NonNullable<StreamOptions["reasoning"]>;

const REASONING_LEVELS = new Set<ReasoningLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function exactModel(models: ChatModel[], reference: string): ChatModel | undefined {
  const normalized = reference.toLowerCase();
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonical.length === 1) return canonical[0];
  const byId = models.filter((model) => model.id.toLowerCase() === normalized);
  return byId.length === 1 ? byId[0] : undefined;
}

function resolveModel(
  context: ModelContext,
  reference: string | undefined,
): { model: ChatModel; reasoning?: ReasoningLevel } {
  if (!reference) {
    if (!context.model) throw new Error("No model selected");
    return { model: context.model };
  }

  const models = context.modelRegistry.getAll();
  const direct = exactModel(models, reference);
  if (direct) return { model: direct };

  const lastColon = reference.lastIndexOf(":");
  if (lastColon > 0) {
    const suffix = reference.slice(lastColon + 1) as ReasoningLevel;
    if (REASONING_LEVELS.has(suffix)) {
      const model = exactModel(models, reference.slice(0, lastColon));
      if (model) return { model, reasoning: suffix };
    }
  }

  throw new Error(`Configured model is unavailable: ${reference}`);
}

function textOf(response: ModelResponse): string | null {
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || null;
}

function abortError(): Error {
  const error = new Error("Model call aborted");
  error.name = "AbortError";
  return error;
}

export function createModelCall(
  context: ModelContext,
  report: (event: ModelUsageEvent) => void,
  source = "pi-repos",
): ModelCall {
  return async (request) => {
    const startedAt = Date.now();
    let selected: ChatModel | undefined;
    let response: ModelResponse | undefined;

    try {
      const resolved = resolveModel(context, request.model);
      selected = resolved.model;
      const options: StreamOptions = {
        ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      };
      response = await context.modelRegistry.streamSimple(
        selected,
        {
          systemPrompt: request.systemPrompt,
          messages: [{
            role: "user",
            content: [{ type: "text", text: request.prompt }],
            timestamp: Date.now(),
          }],
        },
        options,
      ).result();

      report({
        source,
        operation: request.operation,
        model: `${selected.provider}/${selected.id}`,
        input: response.usage.input,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        output: response.usage.output,
        reasoning: response.usage.reasoning ?? 0,
        cost: response.usage.cost.total,
        durationMs: Date.now() - startedAt,
        trigger: request.trigger ?? "user",
        status: response.stopReason === "error" || response.stopReason === "aborted" ? "error" : "complete",
        route: `${response.provider}/${response.model}`,
      });

      if (response.stopReason === "aborted") throw abortError();
      if (response.stopReason === "error") throw new Error(response.errorMessage || "Model call failed");
      return textOf(response);
    } catch (error) {
      if (!response) {
        report({
          source,
          operation: request.operation,
          model: selected ? `${selected.provider}/${selected.id}` : request.model ?? "unconfigured",
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          cost: 0,
          durationMs: Date.now() - startedAt,
          trigger: request.trigger ?? "user",
          status: "error",
        });
      }
      throw error;
    }
  };
}
