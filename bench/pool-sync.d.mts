export interface PoolSyncOptions {
  poolPath?: string;
  localMetadataPath?: string;
  rootDir?: string;
  archiveDir?: string;
  dryRun?: boolean;
  shallow?: boolean;
  tiers?: string[];
  repos?: string[];
}

export function parsePoolSyncArgs(argv: string[]): {
  poolPath: string;
  localMetadataPath: string;
  rootDir: string;
  archiveDir: string;
  dryRun: boolean;
  shallow: boolean;
  tiers: string[];
  repos: string[];
};

export function materializeBenchmarkPool(options?: PoolSyncOptions): {
  ok: boolean;
  poolPath: string;
  localMetadataPath: string;
  rootDir: string;
  archiveDir: string;
  dryRun: boolean;
  shallow: boolean;
  requestedTiers: string[];
  requestedRepos: string[];
  actions: Array<Record<string, any>>;
  errors: string[];
  warnings: string[];
};
