import { ClientRegistry } from "@boundaryml/baml";
import type { BamlSettings, ModelRegistry, ModelTier } from "./types.js";

export type { ModelRegistry };

/** Result of resolving a model tier — everything needed for BAML. */
export interface ResolvedModel {
  readonly clientRegistry: ClientRegistry;
  readonly bamlProvider: string;
}

/** Map Pi API type → BAML provider name. */
/** Pi API types that BAML 0.85.0 cannot support. */
const UNSUPPORTED_PI_APIS = new Set(["openai-responses"]);

const PI_API_TO_BAML_PROVIDER: Readonly<Record<string, string>> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai-generic",
  "openai-responses": "openai-generic", // posts to /chat/completions — only works if proxy accepts both
  "google-generative-ai": "google-ai",
  "google-vertex": "vertex-ai",
  "bedrock-converse-stream": "aws-bedrock",
};

export function mapPiApiToBamlProvider(piApi: string): string {
  if (UNSUPPORTED_PI_APIS.has(piApi)) {
    throw new Error(
      `Model uses "${piApi}" API which is not supported by BAML 0.85.0. ` +
      `Choose a model that uses anthropic-messages or openai-completions instead.`,
    );
  }
  return PI_API_TO_BAML_PROVIDER[piApi] ?? "openai-generic";
}

/**
 * Resolve a model tier to a ready-to-use ClientRegistry.
 *
 * 1. Reads the "provider/model-id" from settings for the given tier
 * 2. Looks up the model in Pi's ModelRegistry
 * 3. Gets auth (apiKey + headers)
 * 4. Builds and returns a ClientRegistry with "PiClient" as primary
 */
export async function resolveModelTier(
  settings: BamlSettings,
  modelRegistry: ModelRegistry,
  tier: ModelTier = "standard",
): Promise<ResolvedModel> {
  const ref = settings.models[tier];
  const slashIdx = ref.indexOf("/");
  const provider = ref.slice(0, slashIdx);
  const modelId = ref.slice(slashIdx + 1);

  // Look up model in Pi's registry
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(
      `Model "${ref}" not found in Pi's ModelRegistry. Check baml.models.${tier} in settings.json.`,
    );
  }

  // Get auth — pass the full model object so Pi can resolve provider-specific config
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Auth failed for "${ref}": ${auth.error}`);
  }

  // Determine BAML provider from the model's API type
  const bamlProvider = mapPiApiToBamlProvider(model.api);

  // Build ClientRegistry
  const cr = new ClientRegistry();
  const options: Record<string, unknown> = {
    model: modelId,
    api_key: auth.apiKey ?? "",
  };
  if (model.baseUrl) {
    options["base_url"] = model.baseUrl;
  }
  const mergedHeaders: Record<string, string> = { ...model.headers, ...auth.headers };

  // GitHub Copilot proxy requires Bearer auth and additional headers that Pi
  // normally injects per-request (see pi-ai/providers/github-copilot-headers.js).
  if (provider === "github-copilot") {
    mergedHeaders["X-Initiator"] = "user";
    mergedHeaders["Openai-Intent"] = "conversation-edits";
    mergedHeaders["anthropic-dangerous-direct-browser-access"] = "true";
    mergedHeaders["accept"] = "application/json";

    if (bamlProvider === "anthropic") {
      // BAML's anthropic provider sends x-api-key, but Copilot needs Authorization: Bearer.
      // Override auth via headers; set api_key to dummy (Copilot ignores x-api-key).
      mergedHeaders["Authorization"] = `Bearer ${auth.apiKey ?? ""}`;
      options["api_key"] = "not-used";
    }
    // For openai-generic: BAML natively sends Authorization: Bearer <api_key>,
    // so the real token stays in options.api_key (set above). No override needed.
  }

  if (Object.keys(mergedHeaders).length > 0) {
    options["headers"] = mergedHeaders;
  }

  cr.addLlmClient("PiClient", bamlProvider, options);
  cr.setPrimary("PiClient");

  return { clientRegistry: cr, bamlProvider };
}
