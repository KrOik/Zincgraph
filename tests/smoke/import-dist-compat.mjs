import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const exportedEntries = [
  ['zincgraph/fusion/query-engine', 'dist/fusion/query-engine.js'],
  ['zincgraph/fusion/queryEngine', 'dist/fusion/queryEngine.js'],
  ['zincgraph/fusion/intent-router', 'dist/fusion/intent-router.js'],
  ['zincgraph/fusion/intentRouter', 'dist/fusion/intentRouter.js'],
  ['zincgraph/fusion/context-budget', 'dist/fusion/context-budget.js'],
  ['zincgraph/fusion/contextBudget', 'dist/fusion/contextBudget.js'],
  ['zincgraph/freshness/freshness-gate', 'dist/freshness/freshness-gate.js'],
  ['zincgraph/freshness/freshnessGate', 'dist/freshness/freshnessGate.js'],
  ['zincgraph/behavior/graph-review', 'dist/behavior/graph-review.js'],
  ['zincgraph/behavior/graphReview', 'dist/behavior/graphReview.js'],
  ['zincgraph/behavior/review-command', 'dist/behavior/review-command.js'],
  ['zincgraph/behavior/dedup-check', 'dist/behavior/dedup-check.js'],
  ['zincgraph/behavior/dedupCheck', 'dist/behavior/dedupCheck.js'],
  ['zincgraph/behavior/dedup-command', 'dist/behavior/dedup-command.js'],
  ['zincgraph/behavior/impact-yagni', 'dist/behavior/impact-yagni.js'],
  ['zincgraph/behavior/impactYagni', 'dist/behavior/impactYagni.js'],
  ['zincgraph/mcp/tool-registry', 'dist/mcp/tool-registry.js'],
  ['zincgraph/mcp/unified-server', 'dist/mcp/unified-server.js'],
  ['zincgraph/mcp/unifiedServer', 'dist/mcp/unifiedServer.js'],
  ['zincgraph/installer/unified-installer', 'dist/installer/unified-installer.js'],
  ['zincgraph/installer/unifiedInstaller', 'dist/installer/unifiedInstaller.js'],
  ['zincgraph/freshness/auto-sync', 'dist/freshness/auto-sync.js'],
  ['zincgraph/freshness/autoSync', 'dist/freshness/autoSync.js']
];

for (const [specifier, distEntry] of exportedEntries) {
  const file = join(repoRoot, distEntry);
  if (!existsSync(file)) {
    throw new Error(`Missing built compatibility entry: ${distEntry}`);
  }
  await import(pathToFileURL(file).href);
  await import(specifier);
  requireFromRepo(specifier);
}

const rootExports = await import('zincgraph');
if (typeof rootExports.runAutoSyncOnce !== 'function') {
  throw new Error('Missing root export: runAutoSyncOnce');
}
if (typeof rootExports.autoSyncProject !== 'function') {
  throw new Error('Missing retained root export: autoSyncProject');
}

const tempDir = join(repoRoot, '.omx', 'tmp');
mkdirSync(tempDir, { recursive: true });
const typecheckFile = join(tempDir, 'package-export-typecheck.ts');
const typecheckConfig = join(tempDir, 'package-export-tsconfig.json');
writeFileSync(typecheckFile, `
import { TopoSemanticQueryEngine, routeWeight } from 'zincgraph/fusion/query-engine';
import { TopoSemanticQueryEngine as CompatEngine } from 'zincgraph/fusion/queryEngine';
import { routeQuery } from 'zincgraph/fusion/intent-router';
import { routeQuery as compatRouteQuery } from 'zincgraph/fusion/intentRouter';
import { applyContextBudget } from 'zincgraph/fusion/context-budget';
import { applyContextBudget as compatApplyContextBudget } from 'zincgraph/fusion/contextBudget';
import { FreshnessGate } from 'zincgraph/freshness/freshness-gate';
import { FreshnessGate as CompatFreshnessGate } from 'zincgraph/freshness/freshnessGate';
import { GraphReviewAnalyzer } from 'zincgraph/behavior/graph-review';
import { GraphReviewAnalyzer as CompatGraphReviewAnalyzer } from 'zincgraph/behavior/graphReview';
import { DedupChecker } from 'zincgraph/behavior/dedup-check';
import { DedupChecker as CompatDedupChecker } from 'zincgraph/behavior/dedupCheck';
import { runDedupCommand } from 'zincgraph/behavior/dedup-command';
import { runGraphReviewCommand } from 'zincgraph/behavior/review-command';
import { ImpactAwareYagni } from 'zincgraph/behavior/impact-yagni';
import { ImpactAwareYagni as CompatImpactAwareYagni } from 'zincgraph/behavior/impactYagni';
import { listZincgraphTools } from 'zincgraph/mcp/tool-registry';
import { createZincgraphMcpServer } from 'zincgraph/mcp/unified-server';
import { createZincgraphMcpServer as createCompatMcpServer } from 'zincgraph/mcp/unifiedServer';
import { installZincgraph } from 'zincgraph/installer/unified-installer';
import { installZincgraph as compatInstallZincgraph } from 'zincgraph/installer/unifiedInstaller';
import { runAutoSyncOnce, autoSyncProject } from 'zincgraph';
import { AutoSyncPipeline, runAutoSyncOnce as subpathRunAutoSyncOnce, autoSyncProject as subpathAutoSyncProject } from 'zincgraph/freshness/auto-sync';
import { AutoSyncPipeline as CompatAutoSyncPipeline, runAutoSyncOnce as compatRunAutoSyncOnce, autoSyncProject as compatAutoSyncProject } from 'zincgraph/freshness/autoSync';

const engine: TopoSemanticQueryEngine = new CompatEngine('.');
const route = routeQuery('similar to token');
const compatRoute = compatRouteQuery('authenticateUser');
const weight: number = routeWeight(route, 'vector');
const budget = applyContextBudget([]);
const compatBudget = compatApplyContextBudget([]);
const gate: FreshnessGate = new CompatFreshnessGate('.');
const review: GraphReviewAnalyzer = new CompatGraphReviewAnalyzer();
const dedup: DedupChecker = new CompatDedupChecker('.', { dependencies: { search: async () => [] } });
const yagni: ImpactAwareYagni = new CompatImpactAwareYagni();
void [engine, route, compatRoute, weight, budget, compatBudget, gate, review, dedup, runDedupCommand, runGraphReviewCommand, yagni, listZincgraphTools, createZincgraphMcpServer, createCompatMcpServer, installZincgraph, compatInstallZincgraph, runAutoSyncOnce, autoSyncProject, AutoSyncPipeline, subpathRunAutoSyncOnce, subpathAutoSyncProject, CompatAutoSyncPipeline, compatRunAutoSyncOnce, compatAutoSyncProject];
`);
writeFileSync(typecheckConfig, JSON.stringify({
  compilerOptions: {
    noEmit: true,
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    skipLibCheck: true
  },
  files: [typecheckFile]
}, null, 2));
try {
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--project', typecheckConfig],
    { cwd: repoRoot, stdio: 'pipe' }
  );
} finally {
  rmSync(typecheckFile, { force: true });
  rmSync(typecheckConfig, { force: true });
}

console.log(`compat package exports ok: ${exportedEntries.length}`);
