import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { FusionStore } from './fusion-store.js';
import { DEFAULT_FRESHNESS_EMBEDDING_PROFILE, summarizeFreshness, type FreshnessSnapshot } from './freshness-gate.js';
import { VectorManifestStore, type VectorManifestEntry } from './manifest.js';
import { syncCodeGraphProject } from '../bridge/codegraphAdapter.js';
import { readCodeGraphSnapshot, vectorizeProject, type CodeGraphSnapshot, type VectorizeResult } from '../vector/code-to-vectors.js';

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
  syncProject?: (projectPath: string, event: GraphChangeEvent) => Promise<VectorizeResult | void> | VectorizeResult | void;
  readSnapshot?: (projectPath: string) => CodeGraphSnapshot;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AutoSyncPipelineOptions {
  embeddingProfile?: string;
  debounceMs?: number;
  dependencies?: AutoSyncPipelineDependencies;
}

export interface RunAutoSyncOnceDependencies extends Omit<AutoSyncPipelineDependencies, 'syncProject'> {
  syncCodeGraph?: (projectPath: string) => Promise<unknown> | unknown;
  vectorize?: (projectPath: string) => Promise<VectorizeResult> | VectorizeResult;
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
}

export class AutoSyncPipeline {
  private readonly projectPath: string;
  private readonly embeddingProfile: string;
  private readonly debounceMs: number;
  private readonly syncProject: (projectPath: string, event: GraphChangeEvent) => Promise<VectorizeResult | void> | VectorizeResult | void;
  private readonly readSnapshot: (projectPath: string) => CodeGraphSnapshot;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private activeSyncs = 0;
  private lastWarning: string | null = null;

  constructor(projectPath = process.cwd(), options: AutoSyncPipelineOptions = {}) {
    this.projectPath = resolve(projectPath);
    this.embeddingProfile = options.embeddingProfile ?? DEFAULT_FRESHNESS_EMBEDDING_PROFILE;
    this.debounceMs = options.debounceMs ?? 250;
    this.syncProject = options.dependencies?.syncProject ?? ((target) => vectorizeProject(target));
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
    const manifest = new VectorManifestStore(fusionStore, this.embeddingProfile);
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
      await this.syncProject(this.projectPath, sanitizedEvent);
      const snapshot = this.readSnapshot(this.projectPath);
      for (const transition of transitions) {
        const snapshotFile = snapshot.files.find((file) => file.path === transition.filePath);
        const contentHash = snapshotFile?.contentHash ?? transition.stale.contentHash;
        const docIds = snapshot.nodes.filter((node) => node.filePath === transition.filePath).map((node) => node.id);
        transition.fresh = manifest.markFresh(transition.filePath, contentHash, docIds);
      }
      const completedAt = this.now();
      return {
        projectPath: this.projectPath,
        source,
        startedAt,
        completedAt,
        transitions,
        warnings: []
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
        warnings: [message]
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
      const manifest = new VectorManifestStore(fusionStore, this.embeddingProfile);
      const snapshot = summarizeFreshness(manifest.entries());
      return this.lastWarning ? { ...snapshot, warnings: [this.lastWarning, ...snapshot.warnings] } : snapshot;
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
  const pipelineDependencies: AutoSyncPipelineDependencies = {
    syncProject: async (target) => {
      await syncCodeGraph(target);
      return vectorize(target);
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
