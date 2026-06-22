import {
  DedupChecker,
  formatDedupResult,
  runDedupCheck,
  validateThreshold,
  type DedupCheckResult
} from './dedup-check.js';

export interface DedupCommandOptions {
  projectPath?: string;
  describe: string;
  threshold?: number;
  topk?: number;
  checker?: Pick<DedupChecker, 'check'>;
}

export interface DedupCommandResult {
  result: DedupCheckResult;
  output: string;
}

export async function runDedupCommand(options: DedupCommandOptions): Promise<DedupCommandResult> {
  if (options.threshold !== undefined) {
    validateThreshold(options.threshold);
  }
  const checkOptions: Parameters<typeof runDedupCheck>[0] = {
    description: options.describe,
    checker: options.checker ?? new DedupChecker(options.projectPath ?? process.cwd())
  };
  if (options.projectPath !== undefined) {
    checkOptions.projectPath = options.projectPath;
  }
  if (options.threshold !== undefined) {
    checkOptions.threshold = options.threshold;
  }
  if (options.topk !== undefined) {
    checkOptions.topk = options.topk;
  }
  const result = await runDedupCheck(checkOptions);
  return { result, output: formatDedupResult(result) };
}
