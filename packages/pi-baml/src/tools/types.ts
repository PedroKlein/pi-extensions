/**
 * Pi-compatible tool result shape.
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

/**
 * Minimal context passed to tool execute functions.
 */
export interface ToolContext {
  /** Model registry for model lookup and auth */
  modelRegistry: {
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
  } | undefined;
}

/** Tool definition shape. */
export interface ToolDefinition {
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}
