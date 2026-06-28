export interface PoolStatusOptions {
  poolPath?: string;
  localMetadataPath?: string;
  rootDir?: string;
  strictMaterialization?: boolean;
  enforceCanonicalRepoUrls?: boolean;
  enforceFixedPoolShape?: boolean;
}

export function parsePoolStatusArgs(argv: string[]): {
  poolPath: string;
  localMetadataPath: string;
  strictMaterialization: boolean;
};

export function validateBenchmarkPoolContract(options?: PoolStatusOptions): {
  ok: boolean;
  poolPath: string;
  localMetadataPath: string;
  strictMaterialization: boolean;
  errors: string[];
  warnings: string[];
  summary: Record<string, any>;
};
