/**
 * Per-key async FIFO mutex.
 *
 * Serializes async work per key so read-modify-write critical sections
 * against a shared resource (like a plan file) can't interleave.
 *
 * See `docs/design/concurrency.md` for the load-mutate-save race this fixes.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` under a per-key lock. If another task holds the lock for the same
 * key, `fn` waits until that task's returned promise settles (either resolve
 * or reject) before running.
 *
 * Contract:
 *  - FIFO: acquisitions run in the order they were requested.
 *  - Exception-safe: a throwing `fn` releases the lock; the exception propagates
 *    to the caller who invoked it, not to unrelated queued callers.
 *  - No timeout. If a caller wedges, the queue wedges. Wedging surfaces via a
 *    stalled pi-task response, which is preferable to silent lost writes.
 *  - Unrelated keys don't contend.
 */
export async function withKeyedMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();

	// Our critical section: wait for the predecessor to settle, then run `fn`.
	// Predecessor errors are swallowed here so they don't propagate down the queue —
	// each caller receives its own errors via `work` below.
	const work: Promise<T> = previous.catch(() => undefined).then(() => fn());

	// Publish a swallowed tail so the next caller can await without being
	// rejected by our error. Cache the exact promise object so `finally` can
	// safely GC it via identity comparison.
	const publishedTail = work.catch(() => undefined);
	queues.set(key, publishedTail);

	try {
		return await work;
	} finally {
		// GC: if we're still the tail (no one queued after us), drop the entry
		// so the map doesn't leak keys over a long-lived session.
		if (queues.get(key) === publishedTail) {
			queues.delete(key);
		}
	}
}

/**
 * Test-only: clear all held locks. Never call from production code.
 * Exposed so tests can isolate state between cases.
 */
export function _resetMutexQueuesForTests(): void {
	queues.clear();
}
