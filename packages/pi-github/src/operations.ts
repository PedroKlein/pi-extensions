import type { AdapterResult } from "./adapter.js";

export async function executeMutation<T>(
  mutate: () => Promise<AdapterResult>,
  reconcile: () => Promise<T | null>,
  parse: (result: AdapterResult) => T,
): Promise<T> {
  const result = await mutate();
  if (result.outcome === "success") return parse(result);
  if (result.outcome === "outcome-unknown") {
    const existing = await reconcile();
    if (existing) return existing;
  }
  throw new Error(result.stderr || "GitHub mutation failed.");
}
