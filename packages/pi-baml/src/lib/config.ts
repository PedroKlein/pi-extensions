import type { BamlSettings, ModelTierConfig } from "./types.js";

/**
 * Parse the `baml` section from Pi's settings.json content.
 *
 * Expects: { baml: { models: { light: "provider/model", standard: "provider/model", heavy: "provider/model" } } }
 * Throws on missing or malformed entries with actionable error messages.
 */
export function parseBamlSettings(settings: unknown): BamlSettings {
  if (settings === null || settings === undefined || typeof settings !== "object") {
    throw new Error("Missing settings. Provide a settings object with a 'baml' section.");
  }

  const root = settings as Record<string, unknown>;
  const baml = root["baml"];

  if (baml === undefined || baml === null || typeof baml !== "object") {
    throw new Error("Missing 'baml' section in settings. See docs/configuration.md.");
  }

  const raw = baml as Record<string, unknown>;
  const models = parseModels(raw["models"]);
  const functionsDirs = parseStringArray(raw["functionsDirs"]);
  const systemPrompt = parseSystemPrompt(raw["systemPrompt"]);

  return {
    models,
    ...(functionsDirs !== undefined && { functionsDirs }),
    systemPrompt,
  };
}

function parseModels(value: unknown): ModelTierConfig {
  if (value === undefined || value === null || typeof value !== "object") {
    throw new Error(
      "Missing 'baml.models' in settings. Required format: { light: \"provider/model\", standard: \"provider/model\", heavy: \"provider/model\" }",
    );
  }

  const raw = value as Record<string, unknown>;
  const light = validateModelRef(raw["light"], "light");
  const standard = validateModelRef(raw["standard"], "standard");
  const heavy = validateModelRef(raw["heavy"], "heavy");

  return { light, standard, heavy };
}

function validateModelRef(value: unknown, tier: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Missing 'baml.models.${tier}'. Must be a "provider/model-id" string.`,
    );
  }
  if (!value.includes("/")) {
    throw new Error(
      `Invalid 'baml.models.${tier}': "${value}". Must be "provider/model-id" format (e.g. "github-copilot/claude-haiku-4.5").`,
    );
  }
  return value;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return result.length > 0 ? result : undefined;
}

/**
 * Parse the systemPrompt boolean, defaulting to true when absent.
 * Throws on non-boolean values.
 */
function parseSystemPrompt(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error("Invalid 'baml.systemPrompt': must be a boolean");
  }
  return value;
}
