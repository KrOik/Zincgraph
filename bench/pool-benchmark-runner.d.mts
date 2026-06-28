export interface PoolBenchmarkOptions {
  poolPath?: string;
  localMetadataPath?: string;
  resultsRoot?: string;
  runs?: number;
  accept?: boolean;
  tiers?: string[];
  repos?: string[];
}

export interface PoolContract {
  path: string;
  raw: Record<string, any>;
  schemaVersion: number | null;
  scoreModelVersion: string | null;
  repos: Array<Record<string, any>>;
  repoById: Record<string, Record<string, any>>;
}

export function parsePoolBenchmarkArgs(argv: string[]): {
  poolPath: string;
  localMetadataPath: string;
  resultsRoot: string;
  runs: number;
  accept: boolean;
  tiers: string[] | null;
  repos: string[] | null;
};

export function loadPoolContract(poolPath?: string): PoolContract;
export function loadRepoFixtureMap(): Record<string, Array<Record<string, any>>>;
export function normalizeTierSet(tiers: string[] | null | undefined): string[];
export function runPoolBenchmark(options?: PoolBenchmarkOptions): Promise<{
  summary: Record<string, any>;
  report: string;
  resultDir: string;
}>;

export function evaluateRepo(repo: Record<string, any>, cases: Array<Record<string, any>>, repoPath: string, runs: number): Record<string, any>;
export function evaluateCase(repo: Record<string, any>, caseSpec: Record<string, any>, repoPath: string, runs?: number): Record<string, any>;
export function evaluateCaseAsync(repo: Record<string, any>, caseSpec: Record<string, any>, repoPath: string, runs?: number): Promise<Record<string, any>>;
export function summarizeRepoFromCaseResults(repo: Record<string, any>, caseResults: Array<Record<string, any>>): Record<string, any>;
export function runCaseQuery(repoPath: string, query: string, topk: number, runs: number): Record<string, any>;
export function runCaseQueryAsync(repoPath: string, query: string, topk: number, runs: number): Promise<Record<string, any>>;
export function resolveImportTargets(sourceFilePath: string, specifier: string, nodes: Array<Record<string, any>>): string[];
export function validatePoolAgainstFixtures(
  pool: PoolContract,
  fixtureMap: Record<string, Array<Record<string, any>>>,
  enabledRepos: Array<Record<string, any>>,
  localMetadataPath: string
): {
  ok: boolean;
  errors: string[];
  expectedCounts: Record<string, number>;
  fixtureCounts: Record<string, number>;
};
export function selectEnabledRepos(rawPool: Record<string, any>, localMetadataPath: string, options?: Record<string, any>): Array<Record<string, any>>;
export function ensureRepoReady(repoPath: string, repoId: string): Record<string, any>;
export function loadAcceptedBaselineSummary(resultsRoot: string, criteria: Record<string, any>): Record<string, any>;
export function createPoolReport(summary: Record<string, any>): string;
export function getStressArchiveEntry(localMetadata: Record<string, any>, repoId: string): Record<string, any> | null;
export function validateStressLocalMetadata(input: Record<string, any>): void;
export function buildNonMutationProof(before: Record<string, any>, after: Record<string, any>, beforeRepoStates?: Record<string, any>, afterRepoStates?: Record<string, any>): Record<string, any>;
export function fingerprintRoots(projectPath: string, roots?: string[]): Record<string, any>;
export function diffFingerprints(before: Record<string, any>, after: Record<string, any>): { changedPaths: string[]; sqliteVolatilePaths: string[] };
export function diffRepoStates(beforeRepoStates?: Record<string, any>, afterRepoStates?: Record<string, any>): { changedRepoStates: Array<{ repoId: string; before: any; after: any }> };
export function runCommand(command: string[], cwd: string, timeout?: number): Record<string, any>;
export function runCommandAsync(command: string[], cwd: string, timeout?: number): Promise<Record<string, any>>;
export function selectMedianRun(records: Array<Record<string, any>>): Record<string, any> | null;
export function clamp01(value: number): number;
export function median(values: number[]): number;
