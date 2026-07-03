import type {
  BamlExecutor,
  BamlSettings,
  FunctionInfo,
  ModelRegistry,
  ModelTier,
  PiBamlLibrary,
} from "./lib/types.js";
import { createBamlExecutor } from "./lib/executor.js";
import { FunctionsRegistry } from "./lib/registry.js";
import { RuntimeCache } from "./lib/cache.js";
import { resolveModelTier } from "./lib/bridge.js";

export type { ModelRegistry };

/** Input for creating the library object. */
export interface CreateLibraryInput {
  readonly available: boolean;
  readonly loadError?: string;
  readonly settings: BamlSettings;
}

/** Extended library with internal setters used by the extension factory. */
export interface PiBamlLibraryInternal extends PiBamlLibrary {
  setRegistry(registry: FunctionsRegistry): void;
}

/**
 * Create the PiBamlLibrary object emitted on the EventBus.
 *
 * Stateless with respect to ModelRegistry — callers pass it explicitly
 * on every method call, eliminating session_start ordering issues.
 */
export function createPiBamlLibrary(
  input: CreateLibraryInput,
): PiBamlLibraryInternal {
  const { available, loadError, settings } = input;

  let functionsRegistry: FunctionsRegistry = FunctionsRegistry.fromGroups({});
  const runtimeCache = new RuntimeCache<BamlExecutor>();

  function throwUnavailable(): never {
    throw new Error(
      `pi-baml: BAML runtime unavailable: ${loadError ?? "unknown reason"}`,
    );
  }

  if (!available) {
    return {
      available: false,
      createExecutor: async () => throwUnavailable(),
      execBaml: async () => throwUnavailable(),
      call: async () => throwUnavailable(),
      list: () => throwUnavailable(),
      setRegistry: () => {},
    };
  }

  const lib: PiBamlLibraryInternal = {
    available: true,

    async createExecutor(
      files: Record<string, string>,
      modelRegistry: ModelRegistry,
      tier?: ModelTier,
    ): Promise<BamlExecutor> {
      const { clientRegistry, bamlProvider } = await resolveModelTier(settings, modelRegistry, tier);

      return runtimeCache.getOrCreate(files, (f) =>
        createBamlExecutor({ files: f, clientRegistry, syntheticProvider: bamlProvider }),
      );
    },

    async execBaml<T = unknown>(
      code: string,
      fn: string,
      args: Record<string, unknown>,
      modelRegistry: ModelRegistry,
      tier?: ModelTier,
    ): Promise<T> {
      const { clientRegistry, bamlProvider } = await resolveModelTier(settings, modelRegistry, tier);

      const executor = createBamlExecutor({
        files: { "dynamic.baml": code },
        clientRegistry,
        syntheticProvider: bamlProvider,
      });

      try {
        const result = await executor.call<T>(fn, args);
        return result.parsed;
      } finally {
        executor.dispose();
      }
    },

    async call<T = unknown>(
      fn: string,
      args: Record<string, unknown>,
      modelRegistry: ModelRegistry,
      tier?: ModelTier,
    ): Promise<T> {
      const entry = functionsRegistry.resolve(fn);
      const { clientRegistry, bamlProvider } = await resolveModelTier(settings, modelRegistry, tier);

      const executor = runtimeCache.getOrCreate(entry.files, (f) =>
        createBamlExecutor({ files: f, clientRegistry, syntheticProvider: bamlProvider }),
      );

      const result = await executor.call<T>(entry.name, args);
      return result.parsed;
    },

    list(group?: string): FunctionInfo[] {
      return functionsRegistry.list(group);
    },

    setRegistry(registry: FunctionsRegistry): void {
      functionsRegistry = registry;
    },
  };

  return lib;
}
