export {
  getCodeGraphStatus,
  getCodeGraphStatusViaCli,
  indexCodeGraphProject,
  isCodeGraphSdkLoadable,
  runCodeGraphCli,
  searchCodeGraphProject,
  syncCodeGraphProject
} from './bridge/codegraphAdapter.js';
export type {
  CodeEdge,
  CodeGraphCliResult,
  CodeGraphStatus,
  CodeGraphStatusJson,
  CodeNode
} from './bridge/codegraphAdapter.js';

export {
  buildPonytailInstructions,
  createPonytailMcpDescriptor,
  getPonytailAgentAdapters,
  runPonytailReview
} from './bridge/ponytailAdapter.js';
export type {
  PonytailAgentAdapter,
  PonytailCommandDelegation,
  PonytailMode
} from './bridge/ponytailAdapter.js';

export {
  assessZvecNativeWrapper,
  isZvecPackageLoadable,
  probeZvec
} from './bridge/zvecAdapter.js';
export type {
  ZvecNativeWrapperAssessment,
  ZvecProbeResult,
  ZvecScenario
} from './bridge/zvecAdapter.js';

export {
  createCollection,
  dropCollection,
  getCollectionPath,
  getCollectionSchemaFieldNames,
  openCollection
} from './vector/collection-manager.js';
export type {
  CodeVectorCollection,
  CodeVectorQuery
} from './vector/collection-manager.js';

export {
  buildNodeText,
  createVectorDocuments,
  readCodeGraphSnapshot,
  vectorizeProject
} from './vector/code-to-vectors.js';
export type {
  CodeGraphSnapshot,
  CodeGraphSnapshotFile,
  CodeGraphSnapshotNode,
  VectorDocument,
  VectorizeResult
} from './vector/code-to-vectors.js';

export {
  LocalTokenEmbedding,
  NetworkPolicy,
  RemoteProviderBlockedError,
  cosineSimilarity,
  getAdapter,
  sparseCosineSimilarity,
  tokenizeCodeText
} from './vector/embedding/index.js';
export type {
  EmbeddingAdapter,
  EmbeddingProvider,
  EmbeddingResult
} from './vector/embedding/index.js';

export {
  VectorManifestStore
} from './freshness/manifest.js';
export type {
  ManifestState,
  VectorManifestEntry
} from './freshness/manifest.js';
export {
  FusionStore,
  fusionStorePath
} from './freshness/fusion-store.js';
export {
  SemanticStatus
} from './freshness/semantic-status.js';


export {
  TopoSemanticQueryEngine,
  setDynamicPolicy
} from './fusion/query-engine.js';
export type {
  ContextCapsule,
  ContextAnnotationInput,
  BehaviorAnnotationAssignment,
  BehaviorAnnotationMap,
  BehaviorAnnotationProviderOutput,
  FusionNode,
  FusionPolicy,
  FusionQueryOptions,
  FusionSource,
  QueryEngineDependencies,
  TopoSemanticQueryEngineOptions
} from './fusion/query-engine.js';
export {
  parseFusionQuery,
  queryTerms,
  routeQuery
} from './fusion/intent-router.js';
export type {
  ParsedFusionQuery,
  QueryRoute,
  ScalarFilters
} from './fusion/intent-router.js';
export {
  applyContextBudget,
  compareCandidatePriority,
  truncateContent
} from './fusion/context-budget.js';
export type {
  BudgetableCandidate,
  BehaviorAnnotation,
  BehaviorAnnotationSeverity,
  BehaviorAnnotationType,
  ContextBlock,
  ContextCandidateExcerpt,
  ContextBudgetResult,
  EvidenceSource
} from './fusion/context-budget.js';
export {
  DEFAULT_FRESHNESS_EMBEDDING_PROFILE,
  FreshnessGate,
  getFreshnessSnapshot,
  summarizeFreshness
} from './freshness/freshness-gate.js';
export type {
  FreshnessGateOptions,
  FreshnessGateResult,
  FreshnessSnapshot
} from './freshness/freshness-gate.js';

export {
  GraphReviewAnalyzer,
  analyzeGraphReview,
  formatGraphReviewFindings,
  parseAddedDeclarations,
  readGitDiff
} from './behavior/graph-review.js';
export type {
  AddedClassDeclaration,
  AddedFunctionDeclaration,
  AddedImportDeclaration,
  ClassHierarchyEvidence,
  DependencyEdge,
  GraphEvidenceOptions,
  GraphReviewAdditions,
  GraphReviewFinding,
  GraphReviewFindingType,
  GraphReviewResult,
  RedundantImportEvidence
} from './behavior/graph-review.js';
export {
  formatGraphReviewCommandResult,
  runGraphReviewCommand
} from './behavior/review-command.js';
export type {
  GraphReviewCommandOptions,
  GraphReviewCommandResult
} from './behavior/review-command.js';
export {
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_DEDUP_TOPK,
  DedupChecker,
  createVectorDedupSearch,
  formatDedupResult,
  runDedupCheck,
  validateThreshold
} from './behavior/dedup-check.js';
export type {
  DedupCandidate,
  DedupCheckRequest,
  DedupCheckResult,
  DedupCheckerDependencies,
  DedupCollectionOpener,
  DedupDocumentLister,
  DedupRecommendation,
  RunDedupCheckOptions
} from './behavior/dedup-check.js';
export {
  runDedupCommand
} from './behavior/dedup-command.js';
export type {
  DedupCommandOptions,
  DedupCommandResult
} from './behavior/dedup-command.js';
export {
  ImpactAwareYagni,
  assessImpactYagni
} from './behavior/impact-yagni.js';
export type {
  ImpactCallSite,
  ImpactYagniProposal,
  ImpactYagniResult,
  ImpactYagniVerdict
} from './behavior/impact-yagni.js';

export {
  ZINCGRAPH_TOOL_NAMES,
  createZincgraphToolRegistry,
  listZincgraphTools
} from './mcp/tool-registry.js';
export type {
  ToolArguments,
  ZincgraphToolDefinition,
  ZincgraphToolName,
  ZincgraphToolRegistry,
  ZincgraphToolRegistryDependencies,
  ZincgraphToolSource
} from './mcp/tool-registry.js';
export {
  createZincgraphMcpServer,
  startZincgraphMcpServer
} from './mcp/unified-server.js';
export type {
  ZincgraphMcpServerOptions
} from './mcp/unified-server.js';
export {
  detectInstallTargets,
  installZincgraph,
  planZincgraphInstall
} from './installer/unified-installer.js';
export type {
  AgentInstallTargetInput,
  AgentInstallTarget,
  AgentName,
  PlannedWrite,
  UnifiedInstallOptions,
  UnifiedInstallResult,
  UnifiedInstallerDependencies
} from './installer/unified-installer.js';
export {
  AutoSyncPipeline,
  autoSyncProject,
  runAutoSyncOnce
} from './freshness/auto-sync.js';
export type {
  AutoSyncPipelineDependencies,
  AutoSyncPipelineOptions,
  AutoSyncResult,
  AutoSyncTransition,
  GraphChangeEvent,
  GraphChangeSource,
  GraphChangedFile,
  RunAutoSyncOnceInput,
  RunAutoSyncOnceOptions
} from './freshness/auto-sync.js';

// Phase 5: Context Compression Bridging Layer
export {
  compressContentLocal,
  compressMessages,
  isHeadroomPackageLoadable,
  probeHeadroom,
  assessHeadroomFallback
} from './bridge/headroomAdapter.js';
export type {
  HeadroomCompressInput,
  HeadroomCompressOutput,
  HeadroomFallbackAssessment,
  HeadroomProbeResult,
  HeadroomScenario
} from './bridge/headroomAdapter.js';

export {
  CcrStore,
  ccrStorePath
} from './compression/ccr-store.js';
export type {
  CcrEntry,
  CcrStoreOptions
} from './compression/ccr-store.js';

export {
  applyStrategy,
  detectContentType,
  estimateTokens as estimateCompressionTokens,
  selectStrategy
} from './compression/compression-strategy.js';
export type {
  CompressionStrategyName,
  CompressionStrategyOptions,
  CompressionStrategyResult
} from './compression/compression-strategy.js';

export {
  FusionCompressor,
  createProjectFusionCompressor,
  COMPRESSION_MARKER,
  HASH_MARKER
} from './compression/fusion-compressor.js';
export type {
  CompressionOptions,
  CompressionStats,
  FusionCompressionAdapter,
  FusionCompressionResult,
  FusionCompressorOptions
} from './compression/fusion-compressor.js';

export {
  RelevanceScorer,
  createDefaultRelevanceScorer
} from './compression/relevance-scorer.js';
export type {
  EmbeddingFunction,
  RelevanceMode,
  RelevanceScorerAdapter,
  RelevanceScorerDependencies,
  ScoredDocument,
  ScorerOptions,
  TextDocument
} from './compression/relevance-scorer.js';

export {
  CacheAligner,
  createDefaultCacheAligner
} from './compression/cache-aligner.js';
export type {
  AlignmentReport,
  CacheAlignerAdapter,
  CacheAlignerOptions,
  StabilizedTools,
  ToolDefinition as CacheAlignerToolDefinition
} from './compression/cache-aligner.js';

// Phase 6: Feedback loop & compression optimization
export {
  CrossTurnContextTracker,
  PersistentCrossTurnContextTracker,
  ReviewCompressor,
  findingSignature,
  formatReviewCompressionResult
} from './compression/review-compressor.js';
export type {
  AggregatedReviewFinding,
  ReviewCompressionOptions,
  ReviewCompressionResult,
  ReviewCompressorOptions
} from './compression/review-compressor.js';

export {
  CompressionFeedbackLoop
} from './compression/feedback-loop.js';
export type {
  CompressionFeedbackLoopOptions,
  FeedbackSummary
} from './compression/feedback-loop.js';
export {
  FeedbackStore,
  feedbackStorePath
} from './compression/feedback-store.js';
export type {
  CompressionEvent,
  FeedbackSource,
  FeedbackStoreOptions,
  RankingAdjustmentRecord,
  RetrievalEvent,
  ReviewSignatureRecord,
  SessionLog
} from './compression/feedback-store.js';
export {
  DeterministicLearnIntegrationAdapter,
  classifySessionLog,
  createLearnIntegrationAdapter
} from './compression/learn-integration.js';
export type {
  ApplyRulesOptions,
  FailurePattern,
  FailurePatternType,
  GeneratedRule,
  LearnIntegrationAdapter,
  LearnIntegrationOptions,
  LearnResult,
  RuleFormat
} from './compression/learn-integration.js';
export {
  createFeedbackAwarePolicy,
  RankingAdjuster
} from './compression/ranking-adjuster.js';
export type {
  CompressionAggressiveness,
  DynamicFusionPolicy,
  RankingAdjusterOptions,
  RankingAdjustments
} from './compression/ranking-adjuster.js';
