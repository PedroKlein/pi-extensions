/**
 * P1.7 tracer-bullet: load-mutate-save race in plan_tasks update.
 *
 * These tests fire concurrent read-modify-write cycles against a shared
 * "plan" and assert that all mutations persist. Without the mutex the
 * classic last-writer-wins pattern loses N-1 of every N parallel writes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { withKeyedMutex, _resetMutexQueuesForTests } from "../../src/plan-mutex.js";

beforeEach(() => {
	_resetMutexQueuesForTests();
});

// ─── Reproducer: load-mutate-save race ─────────────────────────────────────

/**
 * Simulate the plan_tasks bug in miniature: a shared object read at the top,
 * mutated in place-by-copy, and written back — all with an async gap in the
 * middle. Without serialisation, N parallel writers all read the same
 * initial state and last write wins.
 */
function makeRaceHarness() {
	const store = { data: { count: 0, items: [] as string[] } };
	let readCount = 0;
	let writeCount = 0;

	async function load(): Promise<typeof store.data> {
		readCount++;
		await Promise.resolve(); // async gap = load I/O
		return JSON.parse(JSON.stringify(store.data));
	}

	async function save(next: typeof store.data): Promise<void> {
		writeCount++;
		await Promise.resolve(); // async gap = save I/O
		store.data = next;
	}

	async function unsafeMutate(mutator: (d: typeof store.data) => typeof store.data): Promise<void> {
		const current = await load();
		const next = mutator(current);
		await save(next);
	}

	async function safeMutate(mutator: (d: typeof store.data) => typeof store.data): Promise<void> {
		await withKeyedMutex("test-plan", async () => {
			const current = await load();
			const next = mutator(current);
			await save(next);
		});
	}

	return { store, load, save, unsafeMutate, safeMutate, readCount: () => readCount, writeCount: () => writeCount };
}

describe("load-mutate-save race (reproducer)", () => {
	it("WITHOUT mutex: parallel writes lose all but one (this is the bug)", async () => {
		const h = makeRaceHarness();
		await Promise.all([
			h.unsafeMutate((d) => ({ ...d, items: [...d.items, "a"] })),
			h.unsafeMutate((d) => ({ ...d, items: [...d.items, "b"] })),
			h.unsafeMutate((d) => ({ ...d, items: [...d.items, "c"] })),
		]);
		// Bug: all three read the initial state (items=[]), each writes back one item.
		// Final state has only one item — whichever write landed last.
		expect(h.store.data.items).toHaveLength(1);
	});

	it("WITH mutex: parallel writes all land (three items)", async () => {
		const h = makeRaceHarness();
		await Promise.all([
			h.safeMutate((d) => ({ ...d, items: [...d.items, "a"] })),
			h.safeMutate((d) => ({ ...d, items: [...d.items, "b"] })),
			h.safeMutate((d) => ({ ...d, items: [...d.items, "c"] })),
		]);
		expect(h.store.data.items).toHaveLength(3);
		expect(h.store.data.items.sort()).toEqual(["a", "b", "c"]);
	});

	it("WITH mutex: 10 parallel dependsOn-like updates all persist", async () => {
		const h = makeRaceHarness();
		const jobs = Array.from({ length: 10 }, (_, i) =>
			h.safeMutate((d) => ({ ...d, items: [...d.items, `t${i}`] })),
		);
		await Promise.all(jobs);
		expect(h.store.data.items).toHaveLength(10);
	});
});

// ─── FIFO ordering ─────────────────────────────────────────────────────────

describe("withKeyedMutex FIFO", () => {
	it("runs same-key work strictly in acquisition order", async () => {
		const order: number[] = [];
		const jobs = [1, 2, 3, 4, 5].map((n) =>
			withKeyedMutex("k", async () => {
				await new Promise((r) => setTimeout(r, 5 - n)); // reverse-ordered sleeps
				order.push(n);
			}),
		);
		await Promise.all(jobs);
		expect(order).toEqual([1, 2, 3, 4, 5]);
	});

	it("different keys do not contend", async () => {
		const events: string[] = [];
		const slow = withKeyedMutex("slow", async () => {
			await new Promise((r) => setTimeout(r, 20));
			events.push("slow-done");
		});
		const fast = withKeyedMutex("fast", async () => {
			events.push("fast-done");
		});
		await Promise.all([slow, fast]);
		// fast finished before slow because they used different keys
		expect(events).toEqual(["fast-done", "slow-done"]);
	});
});

// ─── Exception safety ──────────────────────────────────────────────────────

describe("withKeyedMutex exception safety", () => {
	it("propagates the throwing caller's error to that caller only", async () => {
		const results: Array<string | Error> = [];
		const jobs = [
			withKeyedMutex("k", async () => {
				results.push("first-ok");
			}),
			withKeyedMutex("k", async () => {
				throw new Error("second-fails");
			}).catch((e: Error) => results.push(e)),
			withKeyedMutex("k", async () => {
				results.push("third-ok");
			}),
		];
		await Promise.all(jobs);
		expect(results[0]).toBe("first-ok");
		expect(results[1]).toBeInstanceOf(Error);
		expect((results[1] as Error).message).toBe("second-fails");
		expect(results[2]).toBe("third-ok");
	});

	it("a throwing critical section releases the lock — subsequent work runs", async () => {
		await withKeyedMutex("k", async () => {
			throw new Error("boom");
		}).catch(() => undefined);

		let ran = false;
		await withKeyedMutex("k", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});
});

// ─── Add + Update interleave (AC #3) ───────────────────────────────────────

/**
 * Simulate `plan_tasks add` (append to array) and `plan_tasks update` (mutate
 * an element) interleaving. Without the mutex, one clobbers the other's write.
 */
describe("add + update interleave", () => {
	it("WITH mutex: parallel add + update on the same plan both land", async () => {
		type Task = { id: string; dep?: string };
		const store = { tasks: [{ id: "t1" }, { id: "t2" }] as Task[] };

		async function safeMutate(fn: (t: Task[]) => Task[]): Promise<void> {
			await withKeyedMutex("plan", async () => {
				await Promise.resolve();
				const copy = JSON.parse(JSON.stringify(store.tasks)) as Task[];
				const next = fn(copy);
				await Promise.resolve();
				store.tasks = next;
			});
		}

		await Promise.all([
			safeMutate((tasks) => [...tasks, { id: "t3" }]),                     // add
			safeMutate((tasks) => tasks.map((t) => (t.id === "t1" ? { ...t, dep: "x" } : t))), // update
			safeMutate((tasks) => [...tasks, { id: "t4" }]),                     // add
		]);

		const ids = store.tasks.map((t) => t.id).sort();
		expect(ids).toEqual(["t1", "t2", "t3", "t4"]);
		expect(store.tasks.find((t) => t.id === "t1")?.dep).toBe("x");
	});
});
