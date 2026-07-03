import { describe, it, expect, vi } from "vitest";
import { RuntimeCache } from "../../src/lib/cache.js";

describe("RuntimeCache", () => {
  it("calls factory only once for same content", () => {
    const factory = vi.fn().mockReturnValue({ id: "runtime-1" });
    const cache = new RuntimeCache<{ id: string }>();

    const files = { "main.baml": "function A() -> string { }" };

    const first = cache.getOrCreate(files, factory);
    const second = cache.getOrCreate(files, factory);

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("calls factory for different content", () => {
    const factory = vi
      .fn()
      .mockReturnValueOnce({ id: "runtime-1" })
      .mockReturnValueOnce({ id: "runtime-2" });
    const cache = new RuntimeCache<{ id: string }>();

    const r1 = cache.getOrCreate(
      { "a.baml": "function A() -> string { }" },
      factory,
    );
    const r2 = cache.getOrCreate(
      { "a.baml": "function B() -> int { }" },
      factory,
    );

    expect(r1).not.toBe(r2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("produces same hash regardless of file key ordering", () => {
    const factory = vi.fn().mockReturnValue({ id: "runtime" });
    const cache = new RuntimeCache<{ id: string }>();

    const files1 = { "a.baml": "content-a", "b.baml": "content-b" };
    const files2 = { "b.baml": "content-b", "a.baml": "content-a" };

    cache.getOrCreate(files1, factory);
    cache.getOrCreate(files2, factory);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("clear removes all cached entries", () => {
    const factory = vi.fn().mockReturnValue({ id: "runtime" });
    const cache = new RuntimeCache<{ id: string }>();

    const files = { "main.baml": "content" };
    cache.getOrCreate(files, factory);
    expect(factory).toHaveBeenCalledTimes(1);

    cache.clear();

    cache.getOrCreate(files, factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
