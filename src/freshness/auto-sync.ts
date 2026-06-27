import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { FusionStore } from './fusion-store.js';
import { summarizeFreshness, type FreshnessSnapshot } from './freshness-gate.js';
import { VectorManifestStore, type VectorManifestEntry } from './manifest.js';
import { syncCodeGraphProject } from '../bridge/codegraphAdapter.js';
import {
  applyCodeGraphSnapshotReadOptions,
  readCodeGraphSnapshot,
  updateCodeGraphSnapshotCacheFromFiles,
  vectorizeProject,
  type CodeGraphSnapshot,
  type VectorizeProjectOptions,
  type VectorizeResult
} from '../vector/code-to-vectors.js';
import { resolveActiveEmbedding, type ActiveEmbeddingConfigInput } from '../vector/embedding/index.js';

export interface GraphChangedFile {
  path: string;
  contentHash?: string;
}

export interface GraphChangeEvent {
  files: readonly GraphChangedFile[];
  source?: string;
  changedAt?: number;
}

export interface GraphChangeSource {
  start(onChange: (event: GraphChangeEvent) => void | Promise<void>): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface AutoSyncPipelineDependencies {
  syncProject?: (projectPath: string, event: GraphChangeEvent) => Promise<AutoSyncSyncResult | void> | AutoSyncSyncResult | void;
  readSnapshot?: (projectPath: string) => CodeGraphSnapshot;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AutoSyncPipelineOptions {
  embeddingProfile?: string;
  embedding?: ActiveEmbeddingConfigInput;
  debounceMs?: number;
  dependencies?: AutoSyncPipelineDependencies;
}

export interface RunAutoSyncOnceDependencies extends Omit<AutoSyncPipelineDependencies, 'syncProject'> {
  syncCodeGraph?: (projectPath: string) => Promise<unknown> | unknown;
  vectorize?: (projectPath: string, options?: VectorizeProjectOptions) => Promise<VectorizeResult> | VectorizeResult;
}

export interface RunAutoSyncOnceOptions extends Omit<AutoSyncPipelineOptions, 'dependencies'> {
  dependencies?: RunAutoSyncOnceDependencies;
}

export interface RunAutoSyncOnceInput {
  files: readonly (string | GraphChangedFile)[];
  source?: string;
  changedAt?: number;
}

export interface AutoSyncTransition {
  filePath: string;
  stale: VectorManifestEntry;
  pending?: VectorManifestEntry;
  fresh?: VectorManifestEntry;
  failed?: VectorManifestEntry;
}

export interface AutoSyncResult {
  projectPath: string;
  source: string;
  startedAt: number;
  completedAt: number;
  transitions: AutoSyncTransition[];
  warnings: string[];
  usedIncrementalSnapshot: boolean;
  fullSyncFallback: boolean;
  refreshedFileCount: number;
  vectorDocumentsWritten: number;
}

type AutoSyncSyncResult = VectorizeResult & Partial<Pick<
  AutoSyncResult,
  'usedIncrementalSnapshot' | 'fullSyncFallback' | 'refreshedFileCount' | 'vectorDocumentsWritten'
>>;

export class AutoSyncPipeline {
  private readonly projectPath: string;
  private readonly embeddingProfile: string;
  private readonly chunkerVersion: string;
  private readonly debounceMs: number;
  private readonly syncProject: (projectPath: string, event: GraphChangeEvent) => Promise<AutoSyncSyncResult | void> | AutoSyncSyncResult | void;
  private readonly readSnapshot: (projectPath: string) => CodeGraphSnapshot;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private activeSyncs = 0;
  private lastWarning: string | null = null;

  constructor(projectPath = process.cwd(), options: AutoSyncPipelineOptions = {}) {
    this.projectPath = resolve(projectPath);
    const embedding = resolveActiveEmbedding(this.projectPath, {
      ...options.embedding,
      ...(options.embeddingProfile === undefined ? {} : { embeddingProfile: options.embeddingProfile })
    });
    this.embeddingProfile = embedding.profile;
    this.chunkerVersion = embedding.chunkerVersion;
    this.debounceMs = options.debounceMs ?? 250;
    this.syncProject = options.dependencies?.syncProject ?? ((target, event) => vectorizeProject(target, {
      changedFiles: event.files.map((file) => file.path),
      embedding: {
        provider: embedding.provider,
        embeddingProfile: embedding.profile,
        chunkerVersion: embedding.chunkerVersion,
        networkPolicy: embedding.networkPolicy
      },
      dependencies: {
        adapter: embedding.adapter
      }
    }));
    this.readSnapshot = options.dependencies?.readSnapshot ?? readCodeGraphSnapshot;
    this.now = options.dependencies?.now ?? (() => Date.now());
    this.sleep = options.dependencies?.sleep ?? defaultSleep;
  }

  async attach(source: GraphChangeSource): Promise<void> {
    await source.start(async (event) => {
      await this.handleChange(event);
    });
  }

  async handleChange(event: GraphChangeEvent): Promise<AutoSyncResult> {
    const startedAt = this.now();
    const source = event.source ?? 'graph-change-source';
    const changedFiles = normalizeChangedFiles(this.projectPath, event.files);
    const sanitizedEvent: GraphChangeEvent = {
      ...event,
      files: changedFiles
    };
    this.activeSyncs += 1;
    this.lastWarning = `Zincgraph is syncing ${changedFiles.length} changed file(s) from ${source}`;
    const fusionStore = new FusionStore(this.projectPath);
    const manifest = new VectorManifestStore(fusionStore, this.embeddingProfile, this.chunkerVersion);
    const transitions: AutoSyncTransition[] = [];

    try {
      for (const file of changedFiles) {
        transitions.push({ filePath: file.path, stale: manifest.markStale(file.path, file.contentHash) });
      }
      if (this.debounceMs > 0) {
        await this.sleep(this.debounceMs);
      }
      revalidateChangedFiles(this.projectPath, changedFiles);
      for (const transition of transitions) {
        transition.pending = manifest.markPending(transition.filePath, transition.stale.contentHash);
      }
      const syncResult = await this.syncProject(this.projectPath, sanitizedEvent);
      const refreshedFiles = refreshedFilesByPath(syncResult);
      const snapshot = refreshedFiles ? undefined : this.readSnapshot(this.projectPath);
      const syncStats = syncMetrics(syncResult, transitions.length);
      for (const transition of transitions) {
        const refreshedFile = refreshedFiles?.get(transition.filePath);
        const snapshotFile = refreshedFile
          ? undefined
          : snapshot?.files.find((file) => file.path === transition.filePath);
        const contentHash = refreshedFile?.contentHash ?? snapshotFile?.contentHash ?? transition.stale.contentHash;
        const docIds = refreshedFile?.docIds ?? snapshot?.nodes
          .filter((node) => node.filePath === transition.filePath)
          .map((node) => node.id) ?? [];
        transition.fresh = manifest.markFresh(transition.filePath, contentHash, docIds);
      }
      const completedAt = this.now();
      return {
        projectPath: this.projectPath,
        source,
        startedAt,
        completedAt,
        transitions,
        warnings: [],
        ...syncStats
      };
    } catch (error) {
      if (error instanceof AutoSyncContainmentError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      for (const transition of transitions) {
        transition.failed = manifest.markFailed(transition.filePath, transition.stale.contentHash, message);
      }
      return {
        projectPath: this.projectPath,
        source,
        startedAt,
        completedAt: this.now(),
        transitions,
        warnings: [message],
        usedIncrementalSnapshot: false,
        fullSyncFallback: false,
        refreshedFileCount: 0,
        vectorDocumentsWritten: 0
      };
    } finally {
      this.activeSyncs -= 1;
      if (this.activeSyncs === 0) {
        this.lastWarning = null;
      }
      fusionStore.close();
    }
  }

  freshness(): FreshnessSnapshot {
      const fusionStore = new FusionStore(this.projectPath);
      try {
        const manifest = new VectorManifestStore(fusionStore, this.embeddingProfile, this.chunkerVersion);
        const snapshot = summarizeFreshness(manifest.entries());
        const warnings = [
          ...(this.lastWarning ? [this.lastWarning] : []),
          ...manifestSidecarWarnings(this.projectPath, this.embeddingProfile, this.chunkerVersion),
          ...snapshot.warnings
        ];
        return warnings.length > 0 ? { ...snapshot, warnings: [...new Set(warnings)] } : snapshot;
      } finally {
      fusionStore.close();
    }
  }

  isSyncing(): boolean {
    return this.activeSyncs > 0;
  }
}

export async function autoSyncProject(
  projectPath: string,
  event: GraphChangeEvent,
  options: AutoSyncPipelineOptions = {}
): Promise<AutoSyncResult> {
  return new AutoSyncPipeline(projectPath, options).handleChange(event);
}

export async function runAutoSyncOnce(
  projectPath: string,
  input: RunAutoSyncOnceInput,
  options: RunAutoSyncOnceOptions = {}
): Promise<AutoSyncResult> {
  const dependencies = options.dependencies ?? {};
  const syncCodeGraph = dependencies.syncCodeGraph ?? syncCodeGraphProject;
  const vectorize = dependencies.vectorize ?? vectorizeProject;
  const useIncrementalSnapshot =
    dependencies.syncCodeGraph === undefined &&
    dependencies.vectorize === undefined &&
    dependencies.readSnapshot === undefined;
  const pipelineDependencies: AutoSyncPipelineDependencies = {
    syncProject: async (target, event) => {
      let usedIncrementalSnapshot = false;
      let fullSyncFallback = false;
      const incrementalSnapshot = useIncrementalSnapshot
        ? updateCodeGraphSnapshotCacheFromFiles(
          target,
          event.files.map((file) => ({
            path: file.path,
            contentHash: file.contentHash ?? createHash('sha256').update(file.path).digest('hex')
          }))
        )
        : null;
      usedIncrementalSnapshot = incrementalSnapshot !== null;
      fullSyncFallback = useIncrementalSnapshot && incrementalSnapshot === null;
      if (!incrementalSnapshot) {
        await syncCodeGraph(target);
      }
      const result = await vectorize(target, {
        changedFiles: event.files.map((file) => file.path),
        embedding: {
          ...options.embedding,
          ...(options.embeddingProfile === undefined ? {} : { embeddingProfile: options.embeddingProfile })
        },
        ...(dependencies.readSnapshot !== undefined
          ? { dependencies: { readSnapshot: dependencies.readSnapshot } }
          : incrementalSnapshot
            ? {
              dependencies: {
                readSnapshot: (projectPath, snapshotOptions) =>
                  applyCodeGraphSnapshotReadOptions(incrementalSnapshot, projectPath, snapshotOptions)
              }
            }
            : {})
      });
      return {
        ...result,
        usedIncrementalSnapshot,
        fullSyncFallback,
        refreshedFileCount: result.refreshedFiles?.length ?? 0,
        vectorDocumentsWritten: result.documentsWritten
      };
    }
  };
  if (dependencies.readSnapshot !== undefined) {
    pipelineDependencies.readSnapshot = dependencies.readSnapshot;
  }
  if (dependencies.now !== undefined) {
    pipelineDependencies.now = dependencies.now;
  }
  if (dependencies.sleep !== undefined) {
    pipelineDependencies.sleep = dependencies.sleep;
  }

  const pipelineOptions: AutoSyncPipelineOptions = { dependencies: pipelineDependencies };
  if (options.embeddingProfile !== undefined) {
    pipelineOptions.embeddingProfile = options.embeddingProfile;
  }
  if (options.embedding !== undefined) {
    pipelineOptions.embedding = options.embedding;
  }
  if (options.debounceMs !== undefined) {
    pipelineOptions.debounceMs = options.debounceMs;
  }

  if (input.files.length === 0) {
    throw new Error('Auto-sync requires at least one changed file.');
  }
  const event: GraphChangeEvent = {
    files: input.files.map((file) => typeof file === 'string' ? { path: file } : file)
  };
  if (input.source !== undefined) {
    event.source = input.source;
  }
  if (input.changedAt !== undefined) {
    event.changedAt = input.changedAt;
  }

  return new AutoSyncPipeline(projectPath, pipelineOptions).handleChange(event);
}

function refreshedFilesByPath(
  result: AutoSyncSyncResult | void
): Map<string, { contentHash: string; docIds: readonly string[] }> | null {
  if (!result || !Array.isArray(result.refreshedFiles) || result.refreshedFiles.length === 0) {
    return null;
  }
  return new Map(result.refreshedFiles.map((entry) => [
    entry.path,
    { contentHash: entry.contentHash, docIds: entry.docIds }
  ]));
}

function syncMetrics(
  result: AutoSyncSyncResult | void,
  transitionCount: number
): Pick<AutoSyncResult, 'usedIncrementalSnapshot' | 'fullSyncFallback' | 'refreshedFileCount' | 'vectorDocumentsWritten'> {
  return {
    usedIncrementalSnapshot: result?.usedIncrementalSnapshot ?? false,
    fullSyncFallback: result?.fullSyncFallback ?? false,
    refreshedFileCount: result?.refreshedFileCount ?? result?.refreshedFiles?.length ?? transitionCount,
    vectorDocumentsWritten: result?.vectorDocumentsWritten ?? result?.documentsWritten ?? 0
  };
}

function manifestSidecarWarnings(projectPath: string, embeddingProfile: string, chunkerVersion: string): string[] {
  const manifestsDir = join(resolve(projectPath), '.zincgraph', 'manifests');
  const manifestPath = join(
    manifestsDir,
    `manifest-${createHash('sha256').update(`${embeddingProfile}\0${chunkerVersion}`).digest('hex').slice(0, 16)}.json`
  );
  if (!existsSync(manifestPath)) {
    return [];
  }

  const warnings = [`using manifest sidecar ${basename(manifestPath)} for freshness`];
  const cachePath = join(resolve(projectPath), '.zincgraph', 'embedding-metadata.json');
  const fusionDbPath = join(resolve(projectPath), '.zincgraph', 'fusion.sqlite');
  if (!existsSync(cachePath)) {
    warnings.push('embedding metadata cache missing while manifest sidecar exists');
  } else {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { dbMtimeMs?: unknown };
      const cachedDbMtime = typeof parsed.dbMtimeMs === 'number' ? parsed.dbMtimeMs : undefined;
      if (existsSync(fusionDbPath)) {
        const fusionDbMtime = lstatSync(fusionDbPath).mtimeMs;
        if (cachedDbMtime === undefined || cachedDbMtime < fusionDbMtime) {
          warnings.push('embedding metadata cache is older than fusion.sqlite while manifest sidecar exists');
        }
      }
    } catch {
      warnings.push('embedding metadata cache could not be parsed while manifest sidecar exists');
    }
  }

  const sidecars = existsSync(manifestsDir)
    ? requireManifestSidecars(manifestsDir)
    : [];
  if (sidecars.length > 1) {
    warnings.push(`multiple manifest sidecars detected (${sidecars.length}); using ${basename(manifestPath)}`);
  }
  return warnings;
}

function requireManifestSidecars(manifestsDir: string): string[] {
  try {
    return readdirSync(manifestsDir)
      .filter((fileName) => /^manifest-[0-9a-f]{16}\.json$/i.test(fileName))
      .map((fileName) => join(manifestsDir, fileName));
  } catch {
    return [];
  }
}

function normalizeChangedFiles(projectPath: string, files: readonly GraphChangedFile[]): Array<{ path: string; contentHash: string }> {
  const projectRoot = resolve(projectPath);
  return files.map((file) => {
    const normalizedPath = normalizeProjectRelativePath(projectRoot, file.path);
    return {
      path: normalizedPath,
      contentHash: file.contentHash ?? hashFileIfPresent(projectRoot, normalizedPath)
    };
  });
}

function revalidateChangedFiles(projectPath: string, files: readonly GraphChangedFile[]): void {
  const projectRoot = resolve(projectPath);
  for (const file of files) {
    normalizeProjectRelativePath(projectRoot, file.path);
  }
}

function hashFileIfPresent(projectPath: string, filePath: string): string {
  const absolutePath = resolve(projectPath, filePath);
  assertInsideProject(absolutePath, resolve(projectPath), filePath);
  if (!existsSync(absolutePath)) {
    return createHash('sha256').update(filePath).digest('hex');
  }
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function normalizeProjectRelativePath(projectRoot: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new AutoSyncContainmentError(`Auto-sync changed file paths must be project-relative: ${filePath}`);
  }
  const absolutePath = resolve(projectRoot, filePath);
  assertInsideProject(absolutePath, projectRoot, filePath);
  const normalizedPath = relative(projectRoot, absolutePath).split(sep).join('/');
  if (!normalizedPath) {
    throw new AutoSyncContainmentError(`Auto-sync changed file path must reference a file inside the project: ${filePath}`);
  }
  assertNoSymlinkSegments(projectRoot, normalizedPath, filePath);
  return normalizedPath;
}

function assertInsideProject(absolutePath: string, projectRoot: string, inputPath: string): void {
  const pathFromRoot = relative(projectRoot, absolutePath);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new AutoSyncContainmentError(`Auto-sync changed file path escapes project root: ${inputPath}`);
  }
}

function assertNoSymlinkSegments(projectRoot: string, normalizedPath: string, inputPath: string): void {
  let cursor = projectRoot;
  for (const segment of normalizedPath.split('/')) {
    cursor = resolve(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new AutoSyncContainmentError(`Auto-sync changed file path traverses a symlink segment: ${inputPath}`);
    }
  }
}

class AutoSyncContainmentError extends Error {
  override readonly name = 'AutoSyncContainmentError';
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
