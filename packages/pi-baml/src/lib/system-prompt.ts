import type { FunctionsRegistry } from "./registry.js";

/**
 * Render the `<available_baml_functions>` system prompt block.
 *
 * Returns null if the registry has no non-skill groups (nothing to advertise).
 * Groups with a "skill:" prefix are excluded — those are internal to their owning skill.
 *
 * @param registry - The functions registry to render groups from.
 * @returns XML block string, or null when there is nothing to inject.
 */
export function renderBamlSystemPrompt(registry: FunctionsRegistry): string | null {
  const groups = registry.listGroups().filter((g) => !g.name.startsWith("skill:"));

  if (groups.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("<available_baml_functions>");
  lines.push("BAML function groups callable via the baml_run tool.");
  lines.push("Call baml_list with a group name to see function signatures and types before invoking.");
  lines.push("For ad-hoc structured extraction, use baml_exec (see the baml skill for authoring guidance).");
  lines.push("");

  for (const group of groups) {
    lines.push("  <group>");
    lines.push(`    <name>${group.name}</name>`);
    if (group.description !== undefined) {
      lines.push(`    <description>${group.description}</description>`);
    }
    lines.push("  </group>");
  }

  lines.push("</available_baml_functions>");
  return lines.join("\n");
}
