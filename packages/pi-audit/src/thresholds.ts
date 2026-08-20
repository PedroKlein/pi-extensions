export const CONTEXT_THRESHOLDS = [100_000, 200_000, 350_000] as const;

export interface ContextThresholdState {
  observe(tokens: number): number[];
  reset(): void;
}

export function createContextThresholdState(): ContextThresholdState {
  const notified = new Set<number>();

  return {
    observe(tokens) {
      const crossed = CONTEXT_THRESHOLDS.filter(
        (threshold) => tokens >= threshold && !notified.has(threshold),
      );
      for (const threshold of crossed) notified.add(threshold);
      return [...crossed];
    },
    reset() {
      notified.clear();
    },
  };
}

export function shouldShowCompletionCheckpoint(tokens: number): boolean {
  return tokens >= CONTEXT_THRESHOLDS[0];
}
