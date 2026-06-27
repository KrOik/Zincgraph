export const DEFAULT_SPEEDUP_TARGET: number;
export const EXCLUDED_RETRIEVAL_TASK_IDS: Set<string>;
export const DEFAULT_THRESHOLDS: Readonly<Record<string, number>>;
export function isRetrievalTask(task: Record<string, any>): boolean;
export function median(values: number[]): number;
export function evaluateBenchmarkGoal(summary: Record<string, any>, options?: Record<string, any>): {
  passed: boolean;
  failures: string[];
  warnings: string[];
  metrics: Record<string, any>;
};
