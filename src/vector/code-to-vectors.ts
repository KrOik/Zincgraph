import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { FusionStore, fusionStorePath, scopedStoredVectorDocumentId } from '../freshness/fusion-store.js';
import { VectorManifestStore } from '../freshness/manifest.js';
import { SemanticStatus } from '../freshness/semantic-status.js';
import { openCollection, type CodeVectorCollection } from './collection-manager.js';
import {
  embedOrThrow,
  getAdapter,
  resolveActiveEmbedding,
  tokenizeCodeText,
  type ActiveEmbeddingConfigInput,
  type EmbeddingAdapter,
  type ResolvedEmbeddingConfig
} from './embedding/index.js';
import { cacheResolvedEmbedding } from './embedding/config.js';
import type { VectorDocumentInput } from './zvec-adapter.js';
import { DEFAULT_CHUNKER_VERSION } from './chunker.js';
import {
  MAX_SOURCE_FILE_READ_BYTES,
  MAX_SOURCE_SNIPPET_LINES,
  MAX_SOURCE_SNIPPET_CHARS,
  MEANINGFUL_NODE_KINDS,
  applyCodeGraphSnapshotReadOptions,
  readCodeGraphSnapshot,
  safeSourceSnippet,
  updateCodeGraphSnapshotCacheFromFiles,
  type ReadCodeGraphSnapshotOptions,
  type CodeGraphSnapshot,
  type CodeGraphSnapshotFile,
  type CodeGraphSnapshotNode,
  type SourceSnippetIo,
  writeCodeGraphSnapshotCache
} from './codegraph-snapshot.js';

export const DEFAULT_EMBEDDING_PROVIDER = 'local';
export {
  MAX_SOURCE_FILE_READ_BYTES,
  MAX_SOURCE_SNIPPET_LINES,
  MAX_SOURCE_SNIPPET_CHARS,
  MEANINGFUL_NODE_KINDS,
  applyCodeGraphSnapshotReadOptions,
  readCodeGraphSnapshot,
  safeSourceSnippet,
  updateCodeGraphSnapshotCacheFromFiles,
  writeCodeGraphSnapshotCache
};
export type {
  CodeGraphSnapshot,
  CodeGraphSnapshotFile,
  CodeGraphSnapshotNode,
  SourceSnippetIo
};

export interface VectorDocument {
  id: string;
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  content: string;
  contentHash: string;
  chunkerVersion: string;
  tokens: string[];
  contentSparse: Record<number, number>;
  embedding: number[];
  semanticAliases?: string[];
  semanticNeighbors?: VectorDocumentSemanticNeighbor[];
}

export interface VectorDocumentSemanticNeighbor {
  nodeId: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  score: number;
  relationship: 'same-file' | 'semantic-overlap';
}

export interface VectorizeResult {
  projectPath: string;
  collectionPath: string;
  fusionDbPath: string;
  filesFresh: number;
  documentsWritten: number;
  totalDocuments: number;
  refreshedFiles?: Array<{ path: string; contentHash: string; docIds: string[] }>;
  manifestWarnings: string[];
}

export interface VectorizeProjectDependencies {
  adapter?: EmbeddingAdapter;
  readSnapshot?: (projectPath: string, options?: ReadCodeGraphSnapshotOptions) => CodeGraphSnapshot;
}

export interface VectorizeProjectOptions {
  changedFiles?: readonly string[];
  embedding?: ActiveEmbeddingConfigInput;
  dependencies?: VectorizeProjectDependencies;
}
const MAX_SEMANTIC_NEIGHBORS = 4;
const MAX_SEMANTIC_ALIASES = 12;
const MIN_SEMANTIC_TOKEN_LENGTH = 3;
const MAX_SHARED_TOKEN_FREQUENCY_RATIO = 0.35;
const SAME_FILE_NEIGHBOR_BONUS = 0.45;
const ISOLATED_SAME_FILE_BONUS = 0.2;
const GRAPH_RELATION_BONUS = 0.3;
const TOKEN_OVERLAP_THRESHOLD = 0.18;
export function buildNodeText(node: CodeGraphSnapshotNode): string {
  return [
    `path ${node.filePath}`,
    `kind ${node.kind}`,
    `language ${node.language}`,
    `qualified ${node.qualifiedName}`,
    node.signature || node.qualifiedName || node.name,
    node.docstring ?? '',
    node.sourceSnippet ? `source\n${node.sourceSnippet}` : '',
    node.calls.length > 0 ? `calls ${node.calls.join(' ')}` : ''
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n');
}

interface SemanticBridge {
  aliases: string[];
  neighbors: VectorDocumentSemanticNeighbor[];
}

interface GraphRelations {
  relatedByNodeId: Map<string, Set<string>>;
}

interface NodeReferenceIndex {
  exact: Map<string, Set<string>>;
  token: Map<string, Set<string>>;
}

interface SemanticDescriptor {
  node: CodeGraphSnapshotNode;
  baseContent: string;
  baseTokens: string[];
  pathTokens: string[];
  callTokens: string[];
  incomingCallCount: number;
}

export async function createVectorDocuments(
  snapshot: CodeGraphSnapshot,
  adapter: EmbeddingAdapter = getAdapter(DEFAULT_EMBEDDING_PROVIDER),
  nodes: readonly CodeGraphSnapshotNode[] = snapshot.nodes,
  chunkerVersion = DEFAULT_CHUNKER_VERSION
): Promise<VectorDocument[]> {
  const baseContentByNode = new Map(snapshot.nodes.map((node) => [node.id, buildNodeText(node)]));
  const bridges = buildSemanticBridges(snapshot, baseContentByNode);
  const contents = nodes.map((node) => appendSemanticBridgeText(baseContentByNode.get(node.id) ?? buildNodeText(node), bridges.get(node.id)));
  const embeddings = await embedOrThrow(adapter, contents);
  const contentHashByPath = new Map(snapshot.files.map((file) => [file.path, file.contentHash]));
  return nodes.map((node, index) => {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new Error(`Missing embedding result for ${node.id}`);
    }
    const bridge = bridges.get(node.id);
    const content = contents[index] ?? node.qualifiedName;
    const fileHash = contentHashByPath.get(node.filePath) ?? hashText(content);
    return {
      id: node.id,
      nodeId: node.id,
      filePath: node.filePath,
      language: node.language,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      content,
      contentHash: fileHash,
      chunkerVersion,
      tokens: embedding.tokens,
      contentSparse: embedding.sparse,
      embedding: embedding.dense,
      ...(bridge?.aliases.length ? { semanticAliases: bridge.aliases } : {}),
      ...(bridge?.neighbors.length ? { semanticNeighbors: bridge.neighbors } : {})
    };
  });
}

function buildSemanticBridges(
  snapshot: CodeGraphSnapshot,
  baseContentByNode: ReadonlyMap<string, string>
): Map<string, SemanticBridge> {
  const incomingCallCounts = countIncomingCalls(snapshot);
  const graphRelations = buildGraphRelations(snapshot);
  const descriptors = snapshot.nodes.map((node) => {
    const baseContent = baseContentByNode.get(node.id) ?? buildNodeText(node);
    return {
      node,
      baseContent,
      baseTokens: tokenizeCodeText(baseContent),
      pathTokens: tokenizeCodeText(node.filePath),
      callTokens: tokenizeCodeText(node.calls.join(' ')),
      incomingCallCount: incomingCallCounts.get(node.name.toLowerCase()) ?? 0
    } satisfies SemanticDescriptor;
  });
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.node.id, descriptor]));
  const descriptorsByFile = new Map<string, SemanticDescriptor[]>();
  for (const descriptor of descriptors) {
    const list = descriptorsByFile.get(descriptor.node.filePath) ?? [];
    list.push(descriptor);
    descriptorsByFile.set(descriptor.node.filePath, list);
  }

  const tokenIndex = new Map<string, Set<string>>();
  for (const descriptor of descriptors) {
    for (const token of descriptor.baseTokens) {
      if (token.length < MIN_SEMANTIC_TOKEN_LENGTH) {
        continue;
      }
      const bucket = tokenIndex.get(token) ?? new Set<string>();
      bucket.add(descriptor.node.id);
      tokenIndex.set(token, bucket);
    }
  }

  const maxSharedTokenFrequency = Math.max(2, Math.ceil(descriptors.length * MAX_SHARED_TOKEN_FREQUENCY_RATIO));
  const bridges = new Map<string, SemanticBridge>();

  for (const descriptor of descriptors) {
    const candidateIds = new Set<string>();
    for (const peer of descriptorsByFile.get(descriptor.node.filePath) ?? []) {
      if (peer.node.id !== descriptor.node.id) {
        candidateIds.add(peer.node.id);
      }
    }
    for (const relatedId of graphRelations.relatedByNodeId.get(descriptor.node.id) ?? []) {
      if (relatedId !== descriptor.node.id) {
        candidateIds.add(relatedId);
      }
    }
    for (const token of descriptor.baseTokens) {
      if (token.length < MIN_SEMANTIC_TOKEN_LENGTH) {
        continue;
      }
      const bucket = tokenIndex.get(token);
      if (!bucket || bucket.size > maxSharedTokenFrequency) {
        continue;
      }
      for (const candidateId of bucket) {
        if (candidateId !== descriptor.node.id) {
          candidateIds.add(candidateId);
        }
      }
    }

    const relationDegree = descriptor.node.calls.length + descriptor.incomingCallCount;
    const neighbors = [...candidateIds]
      .map((candidateId) => {
        const other = descriptorById.get(candidateId);
        if (!other) {
          return null;
        }
        const sameFile = other.node.filePath === descriptor.node.filePath;
        const sharedBaseTokens = intersectCount(descriptor.baseTokens, other.baseTokens);
        const sharedPathTokens = intersectCount(descriptor.pathTokens, other.pathTokens);
        const sharedCallTokens = intersectCount(descriptor.callTokens, other.callTokens);
        const graphRelationBonus = graphRelations.relatedByNodeId.get(descriptor.node.id)?.has(other.node.id) ? GRAPH_RELATION_BONUS : 0;
        let score = 0;
        if (sameFile) {
          score += SAME_FILE_NEIGHBOR_BONUS;
          if (relationDegree === 0) {
            score += ISOLATED_SAME_FILE_BONUS;
          }
        }
        score += graphRelationBonus;
        score += sharedBaseTokens / Math.max(2, Math.min(descriptor.baseTokens.length, other.baseTokens.length));
        score +=
          (sharedPathTokens / Math.max(1, Math.min(descriptor.pathTokens.length, other.pathTokens.length))) * 0.25;
        score +=
          (sharedCallTokens / Math.max(1, Math.min(descriptor.callTokens.length, other.callTokens.length))) * 0.2;
        if (!sameFile && score < TOKEN_OVERLAP_THRESHOLD) {
          return null;
        }
        return {
          nodeId: other.node.id,
          qualifiedName: other.node.qualifiedName,
          filePath: other.node.filePath,
          kind: other.node.kind,
          score: Number(score.toFixed(3)),
          relationship: sameFile ? 'same-file' as const : 'semantic-overlap' as const
        };
      })
      .filter((neighbor): neighbor is VectorDocumentSemanticNeighbor => neighbor !== null)
      .sort((left, right) => {
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return left.nodeId.localeCompare(right.nodeId);
      })
      .slice(0, MAX_SEMANTIC_NEIGHBORS);

    const aliases = collectSemanticAliases(descriptor, neighbors, descriptorById);
    bridges.set(descriptor.node.id, { aliases, neighbors });
  }

  return bridges;
}

function collectSemanticAliases(
  descriptor: SemanticDescriptor,
  neighbors: readonly VectorDocumentSemanticNeighbor[],
  descriptorById: ReadonlyMap<string, SemanticDescriptor>
): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();

  for (const neighbor of neighbors) {
    const neighborDescriptor = descriptorById.get(neighbor.nodeId);
    const candidates = [
      neighborDescriptor?.node.name,
      neighbor.qualifiedName
    ];
    for (const candidate of candidates) {
      const value = candidate?.trim();
      if (!value || seen.has(value) || descriptor.baseContent.includes(value)) {
        continue;
      }
      seen.add(value);
      aliases.push(value);
      if (aliases.length >= MAX_SEMANTIC_ALIASES) {
        return aliases;
      }
    }
  }

  return aliases;
}

function appendSemanticBridgeText(baseContent: string, bridge: SemanticBridge | undefined): string {
  if (!bridge || (bridge.aliases.length === 0 && bridge.neighbors.length === 0)) {
    return baseContent;
  }
  const parts = [baseContent];
  if (bridge.aliases.length > 0) {
    parts.push('semantic aliases');
    parts.push(...bridge.aliases);
  }
  if (bridge.neighbors.length > 0) {
    parts.push('semantic neighbors');
    parts.push(...bridge.neighbors.map((neighbor) => `${neighbor.relationship} ${neighbor.qualifiedName}`));
  }
  return parts.join('\n');
}

function countIncomingCalls(snapshot: CodeGraphSnapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of snapshot.nodes) {
    for (const call of node.calls) {
      const key = call.trim().toLowerCase();
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function buildGraphRelations(snapshot: CodeGraphSnapshot): GraphRelations {
  const referenceIndex = buildNodeReferenceIndex(snapshot);
  const relatedByNodeId = new Map<string, Set<string>>();

  for (const node of snapshot.nodes) {
    const related = relatedByNodeId.get(node.id) ?? new Set<string>();
    for (const call of node.calls) {
      for (const targetId of resolveNodeReferenceIds(call, referenceIndex)) {
        if (targetId === node.id) {
          continue;
        }
        related.add(targetId);
        const reverse = relatedByNodeId.get(targetId) ?? new Set<string>();
        reverse.add(node.id);
        relatedByNodeId.set(targetId, reverse);
      }
    }
    relatedByNodeId.set(node.id, related);
  }

  return { relatedByNodeId };
}

function buildNodeReferenceIndex(snapshot: CodeGraphSnapshot): NodeReferenceIndex {
  const exact = new Map<string, Set<string>>();
  const token = new Map<string, Set<string>>();
  for (const node of snapshot.nodes) {
    registerNodeReference(exact, node.name, node.id, false);
    registerNodeReference(exact, node.qualifiedName, node.id, false);
    registerNodeReference(token, node.name, node.id, true);
    registerNodeReference(token, node.qualifiedName, node.id, true);
  }
  return { exact, token };
}

function registerNodeReference(
  index: Map<string, Set<string>>,
  reference: string,
  nodeId: string,
  tokenized: boolean
): void {
  const normalized = normalizeReferenceKey(reference);
  if (normalized) {
    addToIndex(index, normalized, nodeId);
  }
  if (!tokenized) {
    return;
  }
  for (const token of tokenizeCodeText(reference)) {
    if (token.length < MIN_SEMANTIC_TOKEN_LENGTH) {
      continue;
    }
    addToIndex(index, token, nodeId);
  }
}

function resolveNodeReferenceIds(reference: string, index: NodeReferenceIndex): string[] {
  const normalized = normalizeReferenceKey(reference);
  if (normalized) {
    const exactMatches = index.exact.get(normalized);
    if (exactMatches && exactMatches.size > 0) {
      return [...exactMatches];
    }
  }

  const matches = new Set<string>();
  for (const token of tokenizeCodeText(reference)) {
    if (token.length < MIN_SEMANTIC_TOKEN_LENGTH) {
      continue;
    }
    const bucket = index.token.get(token);
    if (!bucket) {
      continue;
    }
    for (const nodeId of bucket) {
      matches.add(nodeId);
    }
  }
  return [...matches];
}

function addToIndex(index: Map<string, Set<string>>, key: string, nodeId: string): void {
  const bucket = index.get(key) ?? new Set<string>();
  bucket.add(nodeId);
  index.set(key, bucket);
}

function normalizeReferenceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function intersectCount(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  let count = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      count += 1;
    }
  }
  return count;
}

export async function vectorizeProject(projectPath: string, options: VectorizeProjectOptions = {}): Promise<VectorizeResult> {
  const projectRoot = resolve(projectPath);
  const dependencies = options.dependencies ?? {};
  const snapshotReader = dependencies.readSnapshot ?? readCodeGraphSnapshot;
  const changedFilePaths = options.changedFiles
    ? new Set(options.changedFiles.map((filePath) => normalizeProjectFilePath(projectRoot, filePath)))
    : undefined;
  const snapshot = snapshotReader(projectRoot, changedFilePaths
    ? { includeSourceSnippets: true, sourceSnippetFiles: [...changedFilePaths] }
    : undefined);
  const resolvedEmbedding = resolveVectorizeEmbedding(projectRoot, options);
  cacheResolvedEmbedding(projectRoot, resolvedEmbedding);
  const adapter = resolvedEmbedding.adapter;
  const collection: CodeVectorCollection = openCollection(projectRoot, {
    embeddingProfile: resolvedEmbedding.profile,
    chunkerVersion: resolvedEmbedding.chunkerVersion,
    queryAdapter: adapter
  });
  const fusionStoreExists = existsSync(fusionStorePath(projectRoot));
  let fusionStore: FusionStore | undefined;
  let manifest: VectorManifestStore | undefined;
  const ensureManifest = (): VectorManifestStore => {
    if (!fusionStore) {
      fusionStore = new FusionStore(projectRoot);
    }
    if (!manifest) {
      manifest = new VectorManifestStore(
        fusionStore,
        resolvedEmbedding.profile,
        resolvedEmbedding.chunkerVersion
      );
    }
    return manifest;
  };
  let documentsWritten = 0;
  let refreshedFiles: NonNullable<VectorizeResult['refreshedFiles']> = [];

  try {
    const currentFiles = new Map(snapshot.files.map((file) => [file.path, file]));
    const existingEntries = fusionStoreExists ? ensureManifest().entries() : [];
    const existingEntryByFile = new Map<string, typeof existingEntries[number]>();
    for (const entry of existingEntries) {
      existingEntryByFile.set(entry.filePath, entry);
    }
    const finalEntries = new Map<string, typeof existingEntries[number]>();
    for (const entry of existingEntries) {
      finalEntries.set(entry.filePath, entry);
    }

    const candidateFiles = changedFilePaths
      ? snapshot.files.filter((file) => changedFilePaths.has(file.path))
      : snapshot.files;

    const filesToRefresh = candidateFiles.filter((file) => {
      const existing = existingEntryByFile.get(file.path);
      return !existing || existing.contentHash !== file.contentHash || existing.state !== 'fresh' || existing.docIds.length === 0;
    });
    const filesToRemove = existingEntries
      .map((entry) => entry.filePath)
      .filter((filePath) => !currentFiles.has(filePath) && (!changedFilePaths || changedFilePaths.has(filePath)));
    const filePathsToClear = [...new Set([...filesToRefresh.map((file) => file.path), ...filesToRemove])];

    if (filePathsToClear.length > 0) {
      ensureManifest();
      const activeFusionStore = fusionStore!;
      collection.deleteDocumentsByFilePaths(filePathsToClear);
      activeFusionStore.deleteVectorDocumentsByFilePaths(
        filePathsToClear,
        resolvedEmbedding.profile,
        resolvedEmbedding.chunkerVersion
      );
    }
    if (filesToRemove.length > 0) {
      const activeManifest = ensureManifest();
      activeManifest.deleteFiles(filesToRemove);
      for (const filePath of filesToRemove) {
        finalEntries.delete(filePath);
      }
    }

    if (filesToRefresh.length > 0) {
      const activeManifest = ensureManifest();
      const activeFusionStore = fusionStore!;
      const changedFilePaths = new Set(filesToRefresh.map((file) => file.path));
      const changedNodes = snapshot.nodes.filter((node) => changedFilePaths.has(node.filePath));
      const documents = await createVectorDocuments(
        snapshot,
        adapter,
        changedNodes,
        resolvedEmbedding.chunkerVersion
      );
      documentsWritten = documents.length;
      const vectorInputs: VectorDocumentInput[] = documents.map((document) => ({
        id: document.id,
        nodeId: document.nodeId,
        filePath: document.filePath,
        language: document.language,
        kind: document.kind,
        qualifiedName: document.qualifiedName,
        contentHash: document.contentHash,
        chunkerVersion: document.chunkerVersion,
        contentSparse: document.contentSparse,
        embedding: document.embedding
      }));

      collection.insertDocuments(vectorInputs);

      activeFusionStore.upsertVectorDocuments(
        documents.map((document) => ({
          id: scopedStoredVectorDocumentId(document.id, resolvedEmbedding.profile, document.chunkerVersion),
          nodeId: document.nodeId,
          filePath: document.filePath,
          embeddingProfile: resolvedEmbedding.profile,
          chunkerVersion: document.chunkerVersion,
          json: document
        }))
      );

      const docIdsByFile = new Map<string, string[]>();
      for (const document of documents) {
        const docIds = docIdsByFile.get(document.filePath) ?? [];
        docIds.push(document.id);
        docIdsByFile.set(document.filePath, docIds);
      }

      const freshEntries = activeManifest.markFreshFiles(filesToRefresh.map((file) => ({
        ...file,
        docIds: docIdsByFile.get(file.path) ?? []
      })));
      refreshedFiles = freshEntries.map((entry) => ({
        path: entry.filePath,
        contentHash: entry.contentHash,
        docIds: [...entry.docIds]
      }));
      for (const entry of freshEntries) {
        finalEntries.set(entry.filePath, entry);
      }
    }

    const finalEntriesList = [...finalEntries.values()];
    const semanticStatus = new SemanticStatus(finalEntriesList);
    const finalSummary = semanticStatus.summary();
    const manifestWarnings = semanticStatus.getWarnings();
    const totalDocuments = collection.count();
    return {
      projectPath: projectRoot,
      collectionPath: collection.path,
      fusionDbPath: fusionStore?.dbPath ?? fusionStorePath(projectRoot),
      filesFresh: finalSummary.fresh,
      documentsWritten,
      totalDocuments,
      refreshedFiles,
      manifestWarnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const activeManifest = ensureManifest();
    const failedFiles = changedFilePaths
      ? [...changedFilePaths].map((filePath) => ({
        path: filePath,
        contentHash: currentSnapshotHash(snapshot, filePath) ?? existingManifestHash(activeManifest, filePath) ?? hashText(filePath)
      }))
      : snapshot.files;
    for (const file of failedFiles) {
      activeManifest.markFailed(file.path, file.contentHash, message);
    }
    throw error;
  } finally {
    collection.destroy();
    fusionStore?.close();
  }
}

export function resolveVectorizeEmbedding(
  projectPath: string,
  options: VectorizeProjectOptions = {}
): ResolvedEmbeddingConfig {
  const adapter = options.dependencies?.adapter;
  if (adapter) {
    const resolved = resolveActiveEmbedding(projectPath, {
      ...options.embedding,
      provider: adapter.provider,
      embeddingProfile: options.embedding?.embeddingProfile ?? adapter.profile
    });
    return {
      ...resolved,
      profile: options.embedding?.embeddingProfile ?? adapter.profile,
      adapter
    };
  }
  return resolveActiveEmbedding(projectPath, options.embedding);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeProjectFilePath(projectRoot: string, filePath: string): string {
  if (!filePath || isAbsolute(filePath)) {
    throw new Error(`changedFiles entries must be project-relative: ${filePath}`);
  }
  const absolutePath = resolve(projectRoot, filePath);
  if (!isPathInside(projectRoot, absolutePath)) {
    throw new Error(`changedFiles entry escapes project root: ${filePath}`);
  }
  return relative(projectRoot, absolutePath).replace(/\\/g, '/');
}

function currentSnapshotHash(snapshot: CodeGraphSnapshot, filePath: string): string | undefined {
  return snapshot.files.find((file) => file.path === filePath)?.contentHash;
}

function existingManifestHash(manifest: VectorManifestStore, filePath: string): string | undefined {
  return manifest.getByFile(filePath)?.contentHash;
}

function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}
