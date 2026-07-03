import { parseReadmeDescription, parseReadmeBody } from "./readme-parser.js";
import { parseTypeDefinitions } from "./type-parser.js";
import type { FunctionEntry, FunctionInfo, GroupInfo, GroupDetail } from "./types.js";

/** Parsed function declaration from .baml source. */
interface ParsedFunction {
  readonly name: string;
  readonly inputTypes: string;
  readonly outputType: string;
}

/**
 * Parse function declarations from BAML source code.
 *
 * Extracts name, input parameters, and return type using regex.
 * Does not validate BAML syntax — that's BamlRuntime's job.
 */
export function parseFunctionDeclarations(source: string): ParsedFunction[] {
  const pattern = /function\s+(\w+)\s*\(([^)]*)\)\s*->\s*(.+?)\s*\{/g;
  const results: ParsedFunction[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    const inputTypes = match[2]?.trim() ?? "";
    const outputType = match[3]?.trim() ?? "";

    if (name) {
      results.push({ name, inputTypes, outputType });
    }
  }

  return results;
}

/**
 * Registry of discovered BAML functions.
 *
 * Deep module: simple interface (resolve, list) hiding directory
 * discovery, function parsing, and collision resolution logic.
 */
export class FunctionsRegistry {
  private readonly entries: Map<string, FunctionEntry> = new Map();
  private readonly shortNameIndex: Map<string, string[]> = new Map();
  private readonly groupDescriptions: Map<string, string> = new Map();
  private readonly groupReadmes: Map<string, string> = new Map();

  private constructor() {}

  /**
   * Create a registry from pre-loaded groups.
   *
   * Each key is a group name (subdirectory), value is a map of
   * filename → BAML source content.
   */
  static fromGroups(
    groups: Record<string, Record<string, string>>,
  ): FunctionsRegistry {
    const registry = new FunctionsRegistry();

    for (const [group, files] of Object.entries(groups)) {
      // Extract and filter README.md — executor must never see it
      const readmeContent = files["README.md"];
      const { "README.md": _, ...bamlFiles } = files;
      const description = readmeContent
        ? parseReadmeDescription(readmeContent)
        : undefined;

      if (description !== undefined) {
        registry.groupDescriptions.set(group, description);
      }
      if (readmeContent !== undefined) {
        registry.groupReadmes.set(group, readmeContent);
      }

      const allFunctions: ParsedFunction[] = [];

      for (const source of Object.values(bamlFiles)) {
        allFunctions.push(...parseFunctionDeclarations(source));
      }

      for (const fn of allFunctions) {
        const qualifiedName = `${group}/${fn.name}`;

        const entry: FunctionEntry = {
          name: fn.name,
          group,
          files: bamlFiles,
          inputTypes: fn.inputTypes,
          outputType: fn.outputType,
          ...(description !== undefined && { description }),
        };

        registry.entries.set(qualifiedName, entry);

        const existing = registry.shortNameIndex.get(fn.name) ?? [];
        existing.push(qualifiedName);
        registry.shortNameIndex.set(fn.name, existing);
      }
    }

    return registry;
  }

  /**
   * Resolve a function by short name or qualified name.
   *
   * Short name: "ExtractActionItems" — works if unambiguous.
   * Qualified name: "extraction/ExtractActionItems" — always works.
   *
   * Throws with actionable hint on ambiguity or not-found.
   */
  resolve(name: string): FunctionEntry {
    // Try qualified name first
    const direct = this.entries.get(name);
    if (direct) {
      return direct;
    }

    // Try short name
    const qualifiedNames = this.shortNameIndex.get(name);

    if (!qualifiedNames || qualifiedNames.length === 0) {
      throw new Error(
        `Function '${name}' not found in the registry. Run baml_list to see available functions.`,
      );
    }

    if (qualifiedNames.length > 1) {
      const options = qualifiedNames.map((qn) => `'${qn}'`).join(" or ");
      throw new Error(
        `Ambiguous function name '${name}'. Use ${options}.`,
      );
    }

    const resolved = this.entries.get(qualifiedNames[0]!);
    if (!resolved) {
      throw new Error(
        `Function '${name}' not found in the registry. Run baml_list to see available functions.`,
      );
    }

    return resolved;
  }

  /** List all functions, optionally filtered by group. */
  list(group?: string): FunctionInfo[] {
    const results: FunctionInfo[] = [];

    for (const [qualifiedName, entry] of this.entries) {
      if (group !== undefined && entry.group !== group) {
        continue;
      }

      results.push({
        name: entry.name,
        group: entry.group,
        qualifiedName,
        inputTypes: entry.inputTypes,
        outputType: entry.outputType,
        ...(entry.description !== undefined && { description: entry.description }),
      });
    }

    return results;
  }

  /** List all groups with names, descriptions, and function names. */
  listGroups(): GroupInfo[] {
    const groupFunctions = new Map<string, string[]>();

    for (const entry of this.entries.values()) {
      const fns = groupFunctions.get(entry.group) ?? [];
      fns.push(entry.name);
      groupFunctions.set(entry.group, fns);
    }

    return [...groupFunctions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, functions]) => {
        const description = this.groupDescriptions.get(name);
        return {
          name,
          ...(description !== undefined && { description }),
          functions,
        };
      });
  }

  /**
   * Get full detail for a specific group.
   *
   * Returns undefined if the group does not exist.
   */
  describeGroup(name: string): GroupDetail | undefined {
    const functions: FunctionInfo[] = [];
    let groupFiles: Readonly<Record<string, string>> | undefined;

    for (const [qualifiedName, entry] of this.entries) {
      if (entry.group !== name) continue;
      functions.push({
        name: entry.name,
        group: entry.group,
        qualifiedName,
        inputTypes: entry.inputTypes,
        outputType: entry.outputType,
        ...(entry.description !== undefined && { description: entry.description }),
      });
      groupFiles ??= entry.files;
    }

    if (functions.length === 0) {
      return undefined;
    }

    // Collect type definitions from all .baml files in the group
    const types: string[] = [];
    for (const source of Object.values(groupFiles ?? {})) {
      types.push(...parseTypeDefinitions(source));
    }

    const readmeContent = this.groupReadmes.get(name);
    const description = this.groupDescriptions.get(name);
    const readme = readmeContent ? parseReadmeBody(readmeContent) : undefined;
    return {
      group: name,
      ...(description !== undefined && { description }),
      ...(readme !== undefined && { readme }),
      types,
      functions,
    };
  }

  /**
   * Merge additional groups into the registry.
   *
   * Only adds groups whose name doesn't already exist — preserves
   * higher-priority groups that were loaded earlier.
   * Used for deferred skill-BAML discovery.
   */
  mergeGroups(groups: Record<string, Record<string, string>>): void {
    for (const [group, files] of Object.entries(groups)) {
      // Skip groups already present (higher-priority source won)
      const alreadyHasGroup = [...this.entries.values()].some(
        (entry) => entry.group === group,
      );
      if (alreadyHasGroup) continue;

      const readmeContent = files["README.md"];
      const { "README.md": _, ...bamlFiles } = files;
      const description = readmeContent
        ? parseReadmeDescription(readmeContent)
        : undefined;

      if (description !== undefined) {
        this.groupDescriptions.set(group, description);
      }
      if (readmeContent !== undefined) {
        this.groupReadmes.set(group, readmeContent);
      }

      const allFunctions: ParsedFunction[] = [];
      for (const source of Object.values(bamlFiles)) {
        allFunctions.push(...parseFunctionDeclarations(source));
      }

      for (const fn of allFunctions) {
        const qualifiedName = `${group}/${fn.name}`;

        const entry: FunctionEntry = {
          name: fn.name,
          group,
          files: bamlFiles,
          inputTypes: fn.inputTypes,
          outputType: fn.outputType,
          ...(description !== undefined && { description }),
        };

        this.entries.set(qualifiedName, entry);

        const existing = this.shortNameIndex.get(fn.name) ?? [];
        existing.push(qualifiedName);
        this.shortNameIndex.set(fn.name, existing);
      }
    }
  }

  /** Check if the registry has any functions. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }
}
