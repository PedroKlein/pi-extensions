import type { FunctionsRegistry } from "../lib/registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Create the baml_list tool.
 *
 * Without a group filter: returns a compact index of all groups via listGroups().
 * With a group filter: returns full detail for that group via describeGroup().
 * Agent uses this to discover what's available before calling baml_run.
 */
export function createBamlListTool(registry: FunctionsRegistry): ToolDefinition {
  return {
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const group =
        typeof args["group"] === "string" ? args["group"] : undefined;

      if (registry.isEmpty) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message:
                "No BAML functions found. Place .baml files in subdirectories of: " +
                "<project>/.agents/baml/, <project>/.pi/baml/, ~/.pi/baml/, or ~/.agents/baml/",
            }),
          }],
          details: undefined,
        };
      }

      if (group === undefined) {
        // Unfiltered: compact index of all groups
        const groups = registry.listGroups();
        return {
          content: [{ type: "text", text: JSON.stringify({ groups }) }],
          details: undefined,
        };
      }

      // Filtered: full detail for one group
      const detail = registry.describeGroup(group);
      if (!detail) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `Group '${group}' not found. Use baml_list without a group filter to see available groups.`,
          }) }],
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(detail) }],
        details: undefined,
      };
    },
  };
}
