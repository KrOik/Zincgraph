import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi } from 'vitest';

const semanticAugmentMock = vi.hoisted(() => {
  const query = vi.fn(async () => [
    {
      id: 'zg-compression',
      nodeId: 'compression-node',
      filePath: 'src/compression/ranking-adjuster.ts',
      language: 'typescript',
      kind: 'function',
      qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
      contentHash: 'compression-hash',
      chunkerVersion: 'codegraph-node-v3-semantic-bridge',
      score: 0.95
    },
    {
      id: 'zg-noise',
      nodeId: 'noise-node',
      filePath: 'src/behavior/dedup-check.ts',
      language: 'typescript',
      kind: 'function',
      qualifiedName: 'src/behavior/dedup-check.ts::createVectorDedupSearch',
      contentHash: 'noise-hash',
      chunkerVersion: 'codegraph-node-v3-semantic-bridge',
      score: 0.9
    }
  ]);
  const destroy = vi.fn();
  const openCollection = vi.fn(() => ({
    query,
    destroy
  }));
  return { query, destroy, openCollection };
});

vi.mock('../../src/vector/collection-manager.js', () => ({
  openCollection: semanticAugmentMock.openCollection
}));

import {
  adaptiveResultLimit,
  buildFastContextCapsule,
  buildRegistryFastCapsule,
  formatFastAffected,
  formatFastGraphNavigation,
  formatFastImpact,
  main,
  readFastSemanticAugments,
  selectRankedNodes,
  toFusionNode,
  type Snapshot,
  type SnapshotNode
} from '../../src/fast-cli.js';

function snapshot(options: { includeStructuralContext?: boolean } = {}): Snapshot {
  return {
    projectPath: '/repo',
    files: [
      { path: 'src/alpha-service.ts', contentHash: 'a', language: 'typescript' },
      { path: 'src/beta-adapter.ts', contentHash: 'b', language: 'typescript' },
      { path: 'tests/alpha-service.test.ts', contentHash: 't1', language: 'typescript' },
      { path: 'tests/unrelated.test.ts', contentHash: 't2', language: 'typescript' }
    ],
    nodes: [
      {
        id: 'alpha',
        kind: 'function',
        name: 'alphaService',
        qualifiedName: 'alphaService',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function alphaService()',
        sourceSnippet: 'export function alphaService() { return betaAdapter(); }',
        calls: ['betaAdapter']
      },
      ...(options.includeStructuralContext ? [{
        id: 'alpha-context',
        kind: 'class',
        name: 'AlphaServiceRuntime',
        qualifiedName: 'AlphaServiceRuntime',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'class AlphaServiceRuntime',
        sourceSnippet: 'export class AlphaServiceRuntime { start() { return alphaService(); } }',
        calls: ['alphaService']
      }] : []),
      {
        id: 'beta',
        kind: 'function',
        name: 'betaAdapter',
        qualifiedName: 'betaAdapter',
        filePath: 'src/beta-adapter.ts',
        language: 'typescript',
        signature: 'function betaAdapter()',
        sourceSnippet: 'export function betaAdapter() { return true; }',
        calls: []
      },
      {
        id: 'alpha-test',
        kind: 'function',
        name: 'tests alphaService',
        qualifiedName: 'alphaService test',
        filePath: 'tests/alpha-service.test.ts',
        language: 'typescript',
        signature: 'test alphaService behavior',
        sourceSnippet: 'import { alphaService } from "../src/alpha-service"; test("alpha service", () => alphaService());',
        calls: ['alphaService']
      },
      {
        id: 'unrelated-test',
        kind: 'function',
        name: 'unrelatedSpec',
        qualifiedName: 'unrelatedSpec',
        filePath: 'tests/unrelated.test.ts',
        language: 'typescript',
        signature: 'test unrelated behavior',
        sourceSnippet: 'test("unrelated", () => true);',
        calls: []
      }
    ]
  };
}

describe('fast CLI generic snapshot behavior', () => {
  test('ranks nodes from query/token overlap without benchmark task hints', () => {
    const nodes = selectRankedNodes(snapshot().nodes, 'alpha service', 2);

    expect(nodes.map((node) => node.filePath)).toEqual([
      'src/alpha-service.ts',
      'tests/alpha-service.test.ts'
    ]);
  });

  test('ranks exact file-path anchors ahead of same-file noise', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'anchor',
        kind: 'function',
        name: 'buildAlphaService',
        qualifiedName: 'src/alpha-service.ts::buildAlphaService',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function buildAlphaService()',
        sourceSnippet: 'export function buildAlphaService() { return alphaService(); }',
        calls: ['alphaService']
      },
      {
        id: 'noise',
        kind: 'function',
        name: 'buildAlphaServiceHelper',
        qualifiedName: 'src/alpha-service.ts::buildAlphaServiceHelper',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function buildAlphaServiceHelper()',
        sourceSnippet: 'export function buildAlphaServiceHelper() { build alpha service helper build alpha service helper; }',
        calls: ['buildAlphaService']
      }
    ];

    const ranked = selectRankedNodes(nodes, 'src/alpha-service.ts buildAlphaService', 2);

    expect(ranked.map((node) => node.id)).toEqual(['anchor', 'noise']);
  });

  test('exact snake_case symbol anchors outrank same-file ancestor context', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'target',
        kind: 'function',
        name: 'create_cli_file_fetcher',
        qualifiedName: 'cli/file_fetcher.rs::create_cli_file_fetcher',
        filePath: 'cli/file_fetcher.rs',
        language: 'rust',
        signature: 'fn create_cli_file_fetcher() -> CliFileFetcher',
        sourceSnippet: 'pub fn create_cli_file_fetcher() -> CliFileFetcher { BlobStoreAdapter::default() }',
        calls: ['BlobStoreAdapter']
      },
      {
        id: 'context',
        kind: 'method',
        name: 'get',
        qualifiedName: 'BlobStoreAdapter::get',
        filePath: 'cli/file_fetcher.rs',
        language: 'rust',
        signature: 'fn get(&self) -> Option<BlobData>',
        sourceSnippet: 'impl BlobStoreAdapter { fn get(&self) -> Option<BlobData> { None } }',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(
      nodes,
      'cli/file_fetcher.rs create_cli_file_fetcher BlobStoreAdapter PermissionedFileFetcherOptions',
      2
    );

    expect(ranked.map((node) => node.id)).toEqual(['target', 'context']);
  });

  test('anchor-rich file stem queries interleave related same-basename runtime files', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'target',
        kind: 'function',
        name: 'create_cli_file_fetcher',
        qualifiedName: 'cli/file_fetcher.rs::create_cli_file_fetcher',
        filePath: 'cli/file_fetcher.rs',
        language: 'rust',
        signature: 'fn create_cli_file_fetcher() -> CliFileFetcher',
        sourceSnippet: 'pub fn create_cli_file_fetcher() -> CliFileFetcher { BlobStoreAdapter::default() }',
        calls: ['PermissionedFileFetcher::new']
      },
      {
        id: 'context',
        kind: 'method',
        name: 'get',
        qualifiedName: 'BlobStoreAdapter::get',
        filePath: 'cli/file_fetcher.rs',
        language: 'rust',
        signature: 'fn get(&self) -> Option<BlobData>',
        sourceSnippet: 'impl BlobStoreAdapter { fn get(&self) -> Option<BlobData> { None } }',
        calls: []
      },
      {
        id: 'resolver-runtime',
        kind: 'method',
        name: 'new',
        qualifiedName: 'PermissionedFileFetcher::new',
        filePath: 'libs/resolver/file_fetcher.rs',
        language: 'rust',
        signature: 'fn new(options: PermissionedFileFetcherOptions) -> Self',
        sourceSnippet: 'impl PermissionedFileFetcher { fn new(options: PermissionedFileFetcherOptions) -> Self { todo!() } }',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(
      nodes,
      'cli/file_fetcher.rs create_cli_file_fetcher BlobStoreAdapter PermissionedFileFetcherOptions',
      3
    );

    expect(ranked[0]?.id).toBe('target');
    expect(ranked.slice(0, 3).map((node) => node.filePath)).toContain('libs/resolver/file_fetcher.rs');
  });

  test('fusion node content keeps exact consequence tokens ahead of long signatures', () => {
    const node: SnapshotNode = {
      id: 'task-runner',
      kind: 'method',
      name: 'run_npm_script',
      qualifiedName: 'TaskRunner::run_npm_script',
      filePath: 'cli/tools/task.rs',
      language: 'rust',
      signature: [
        '(',
        '  &self,',
        '  dir_url: &Url,',
        '  task_name: &str,',
        '  scripts: &IndexMap<String, String>,',
        ') -> Result<i32, AnyError>'
      ].join('\n'),
      sourceSnippet: 'run task script with path setup',
      calls: ['npm_script_env_vars']
    };

    const fusionNode = toFusionNode(node);
    const text = [fusionNode.filePath, fusionNode.qualifiedName, fusionNode.name, fusionNode.content, fusionNode.signature]
      .join('\n')
      .toLowerCase();
    const tokens = new Set(text.split(/[^A-Za-z0-9_.:-]+/g).map((token) => token.trim().toLowerCase()).filter(Boolean));

    expect(fusionNode.content.split('\n')[1]).toMatch(/^tokens /);
    expect(['task', 'run', 'path', 'env', 'script'].every((token) => tokens.has(token))).toBe(true);
  });

  test('mixed exact path and symbol anchors keep the root definition ahead of same-file helper noise', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'root',
        kind: 'class',
        name: 'ExecuteSqlCommand',
        qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand',
        filePath: 'superset/commands/sql_lab/execute.py',
        language: 'python',
        signature: 'class ExecuteSqlCommand',
        sourceSnippet: 'class ExecuteSqlCommand: pass',
        calls: ['ExecuteSqlCommand::__init__']
      },
      {
        id: 'member',
        kind: 'method',
        name: '__init__',
        qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand::__init__',
        filePath: 'superset/commands/sql_lab/execute.py',
        language: 'python',
        signature: 'def __init__(self, execution_context, query_dao)',
        sourceSnippet: 'render validate render validate render validate query render validate sql command helper helper.',
        calls: ['SqlQueryRenderException']
      },
      {
        id: 'noise',
        kind: 'class',
        name: 'RLSAsSubqueryTransformer',
        qualifiedName: 'superset/sql/parse.py::RLSAsSubqueryTransformer',
        filePath: 'superset/sql/parse.py',
        language: 'python',
        signature: 'class RLSAsSubqueryTransformer',
        sourceSnippet: 'render validate path noise',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(
      nodes,
      'superset/commands/sql_lab/execute.py superset/sql/parse.py ExecuteSqlCommand SqlQueryRenderImpl SqlQueryRenderException render validate',
      4
    );

    expect(ranked.map((node) => node.id)[0]).toBe('root');
    expect(ranked.map((node) => node.id)).toContain('member');
  });

  test('ranks later exact symbol anchors ahead of same-shape noise', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'alpha',
        kind: 'function',
        name: 'AlphaService',
        qualifiedName: 'src/alpha.ts::AlphaService',
        filePath: 'src/alpha.ts',
        language: 'typescript',
        signature: 'function AlphaService()',
        sourceSnippet: 'export function AlphaService() { return true; }',
        calls: []
      },
      {
        id: 'beta',
        kind: 'function',
        name: 'BetaAdapter',
        qualifiedName: 'src/secondary.ts::BetaAdapter',
        filePath: 'src/secondary.ts',
        language: 'typescript',
        signature: 'function BetaAdapter()',
        sourceSnippet: 'export function BetaAdapter() { return true; }',
        calls: []
      },
      {
        id: 'noise',
        kind: 'function',
        name: 'BetaAdapterHelper',
        qualifiedName: 'src/beta-adapter-helper.ts::BetaAdapterHelper',
        filePath: 'src/beta-adapter-helper.ts',
        language: 'typescript',
        signature: 'function BetaAdapterHelper()',
        sourceSnippet: 'export function BetaAdapterHelper() { return true; }',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(nodes, 'AlphaService BetaAdapter', 2);

    expect(ranked.map((node) => node.id)).toEqual(['alpha', 'beta']);
  });

  test('ranks later exact path anchors ahead of same-shape noise', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'alpha',
        kind: 'function',
        name: 'buildAlphaService',
        qualifiedName: 'src/alpha-service.ts::buildAlphaService',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function buildAlphaService()',
        sourceSnippet: 'export function buildAlphaService() { return true; }',
        calls: []
      },
      {
        id: 'beta',
        kind: 'function',
        name: 'buildBetaAdapter',
        qualifiedName: 'src/beta-adapter.ts::buildBetaAdapter',
        filePath: 'src/beta-adapter.ts',
        language: 'typescript',
        signature: 'function buildBetaAdapter()',
        sourceSnippet: 'export function buildBetaAdapter() { return true; }',
        calls: []
      },
      {
        id: 'noise',
        kind: 'function',
        name: 'buildBetaAdapterHelper',
        qualifiedName: 'src/beta-adapter-helper.ts::buildBetaAdapterHelper',
        filePath: 'src/beta-adapter-helper.ts',
        language: 'typescript',
        signature: 'function buildBetaAdapterHelper()',
        sourceSnippet: 'export function buildBetaAdapterHelper() { return true; }',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(nodes, 'src/alpha-service.ts src/beta-adapter.ts buildAlphaService buildBetaAdapter', 2);

    expect(ranked.map((node) => node.id)).toEqual(['alpha', 'beta']);
  });

  test('ranks mixed anchor bundles ahead of generic same-shape noise', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'twilio-components',
        kind: 'class',
        name: 'TwilioUsageRecordsStateMigration',
        qualifiedName: 'airbyte-integrations/connectors/source-twilio/components.py::TwilioUsageRecordsStateMigration',
        filePath: 'airbyte-integrations/connectors/source-twilio/components.py',
        language: 'python',
        signature: 'class TwilioUsageRecordsStateMigration',
        sourceSnippet: 'class TwilioUsageRecordsStateMigration: pass',
        calls: ['TwilioStateMigration']
      },
      {
        id: 'twilio-404',
        kind: 'class',
        name: 'TestUsageRecords404Handling',
        qualifiedName: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py::TestUsageRecords404Handling',
        filePath: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py',
        language: 'python',
        signature: 'class TestUsageRecords404Handling',
        sourceSnippet: 'class TestUsageRecords404Handling: pass',
        calls: ['TwilioUsageRecordsStateMigration']
      },
      {
        id: 'noise-check-connection',
        kind: 'function',
        name: 'test_check_connection',
        qualifiedName: 'airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py::test_check_connection',
        filePath: 'airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py',
        language: 'python',
        signature: 'def test_check_connection()',
        sourceSnippet: 'def test_check_connection(): return True',
        calls: ['check_connection']
      },
      {
        id: 'noise-get-cluster',
        kind: 'function',
        name: 'test_get_cluster',
        qualifiedName: 'airbyte-integrations/connectors/source-appsflyer/unit_tests/test_source.py::test_get_cluster',
        filePath: 'airbyte-integrations/connectors/source-appsflyer/unit_tests/test_source.py',
        language: 'python',
        signature: 'def test_get_cluster()',
        sourceSnippet: 'def test_get_cluster(): return True',
        calls: ['get_cluster']
      },
      {
        id: 'noise',
        kind: 'function',
        name: 'test_streams',
        qualifiedName: 'airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py::test_streams',
        filePath: 'airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py',
        language: 'python',
        signature: 'def test_streams()',
        sourceSnippet: 'def test_streams(): return True',
        calls: ['streams']
      }
    ];

    const ranked = selectRankedNodes(
      nodes,
      'TwilioUsageRecordsStateMigration usage_records test_usage_records_404_handling test_streams TwilioStateMigration',
      2
    );

    expect(ranked.map((node) => node.id)).toEqual(['twilio-components', 'twilio-404']);
  });

  test('anchor-rich bundles keep the requested result limit instead of the generic cap', () => {
    expect(
      adaptiveResultLimit(
        snapshot().nodes,
        'TwilioUsageRecordsStateMigration usage_records test_usage_records_404_handling test_streams TwilioStateMigration',
        25
      )
    ).toBe(25);

    expect(adaptiveResultLimit([], 'alpha service', 25)).toBe(10);
  });

  test('anchor-rich bundles can keep multiple relevant nodes from the same file', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'alpha-service',
        kind: 'function',
        name: 'alphaService',
        qualifiedName: 'src/alpha-service.ts::alphaService',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function alphaService()',
        sourceSnippet: 'export function alphaService() { return alphaHelper(); }',
        calls: ['alphaHelper']
      },
      {
        id: 'alpha-helper',
        kind: 'function',
        name: 'alphaHelper',
        qualifiedName: 'src/alpha-service.ts::alphaHelper',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function alphaHelper()',
        sourceSnippet: 'export function alphaHelper() { return true; }',
        calls: []
      },
      {
        id: 'beta-noise',
        kind: 'function',
        name: 'betaService',
        qualifiedName: 'src/beta-service.ts::betaService',
        filePath: 'src/beta-service.ts',
        language: 'typescript',
        signature: 'function betaService()',
        sourceSnippet: 'export function betaService() { return true; }',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(nodes, 'src/alpha-service.ts alphaService alphaHelper', 2);

    expect(ranked.map((node) => node.id)).toEqual(['alpha-service', 'alpha-helper']);
  });

  test('ancestor-qualified members can outrank same-file callback noise in anchor-rich queries', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'worker-bootstrap',
        kind: 'method',
        name: 'bootstrap_from_options',
        qualifiedName: 'MainWorker::bootstrap_from_options',
        filePath: 'runtime/worker.rs',
        language: 'rust',
        signature: 'fn bootstrap_from_options() -> Self',
        sourceSnippet: 'impl MainWorker { fn bootstrap_from_options() { create_permissions_stack_trace_callback(); } }',
        calls: ['create_permissions_stack_trace_callback']
      },
      {
        id: 'worker-from-options',
        kind: 'method',
        name: 'from_options',
        qualifiedName: 'MainWorker::from_options',
        filePath: 'runtime/worker.rs',
        language: 'rust',
        signature: 'fn from_options() -> Self',
        sourceSnippet: 'impl MainWorker { fn from_options() { } }',
        calls: []
      },
      {
        id: 'validate-import-attrs',
        kind: 'function',
        name: 'create_validate_import_attributes_callback',
        qualifiedName: 'create_validate_import_attributes_callback',
        filePath: 'runtime/worker.rs',
        language: 'rust',
        signature: 'fn create_validate_import_attributes_callback()',
        sourceSnippet: 'pub fn create_validate_import_attributes_callback() { }',
        calls: []
      },
      {
        id: 'custom-module-eval',
        kind: 'function',
        name: 'create_custom_module_evaluation_callback',
        qualifiedName: 'create_custom_module_evaluation_callback',
        filePath: 'runtime/worker.rs',
        language: 'rust',
        signature: 'fn create_custom_module_evaluation_callback()',
        sourceSnippet: 'pub fn create_custom_module_evaluation_callback() { }',
        calls: []
      },
      {
        id: 'permissions-stack-trace',
        kind: 'function',
        name: 'create_permissions_stack_trace_callback',
        qualifiedName: 'create_permissions_stack_trace_callback',
        filePath: 'runtime/worker.rs',
        language: 'rust',
        signature: 'fn create_permissions_stack_trace_callback()',
        sourceSnippet: 'pub fn create_permissions_stack_trace_callback() { }',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(
      nodes,
      'runtime/worker.rs create_validate_import_attributes_callback create_custom_module_evaluation_callback create_permissions_stack_trace_callback MainWorker WorkerServiceOptions common_runtime',
      2
    );

    expect(ranked[0]?.id).toBe('worker-bootstrap');
    expect(ranked.map((node) => node.id)).toContain('worker-from-options');
  });

  test('anchor-rich path bundles keep the exact target file ahead of context files', () => {
    const nodes: SnapshotNode[] = [
      {
        id: 'language-server',
        kind: 'method',
        name: 'test_run_cancel_request',
        qualifiedName: 'LanguageServer::test_run_cancel_request',
        filePath: 'cli/lsp/language_server.rs',
        language: 'rust',
        signature: 'fn test_run_cancel_request()',
        sourceSnippet: 'impl LanguageServer { fn test_run_cancel_request() { } }',
        calls: ['run_cancel_request']
      },
      {
        id: 'test-server',
        kind: 'method',
        name: 'run_cancel_request',
        qualifiedName: 'TestServer::run_cancel_request',
        filePath: 'cli/lsp/testing/server.rs',
        language: 'rust',
        signature: 'fn run_cancel_request()',
        sourceSnippet: 'impl TestServer { fn run_cancel_request() { } }',
        calls: []
      },
      {
        id: 'lsp-testing-api',
        kind: 'function',
        name: 'lsp_testing_api',
        qualifiedName: 'lsp_testing_api',
        filePath: 'tests/integration/lsp_tests.rs',
        language: 'rust',
        signature: 'fn lsp_testing_api()',
        sourceSnippet: 'fn lsp_testing_api() { }',
        calls: []
      },
      {
        id: 'code-lens',
        kind: 'function',
        name: 'A',
        qualifiedName: 'tests/bench/testdata/code_lens.ts::A',
        filePath: 'tests/bench/testdata/code_lens.ts',
        language: 'typescript',
        signature: 'const A = 1;',
        sourceSnippet: 'const A = 1;',
        calls: []
      }
    ];

    const ranked = selectRankedNodes(
      nodes,
      'cli/lsp/language_server.rs cli/lsp/testing/server.rs LanguageServer DidChangeBatchQueue StateSnapshot TestServer as_delete_notification run_cancel_request tests/integration/lsp_tests.rs tests/bench/testdata/code_lens.ts',
      1
    );

    expect(ranked.map((node) => node.id)).toEqual(['lsp-testing-api']);
  });

  test('full-json capsules preserve explicit non-testdata test path anchors before broad source anchors', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'cli/lsp/language_server.rs cli/lsp/testing/server.rs LanguageServer DidChangeBatchQueue StateSnapshot TestServer as_delete_notification run_cancel_request tests/integration/lsp_tests.rs tests/bench/testdata/code_lens.ts',
        topk: 1,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'cli/lsp/language_server.rs', contentHash: 'language-server', language: 'rust' },
          { path: 'cli/lsp/testing/server.rs', contentHash: 'testing-server', language: 'rust' },
          { path: 'tests/integration/lsp_tests.rs', contentHash: 'lsp-tests', language: 'rust' },
          { path: 'tests/bench/testdata/code_lens.ts', contentHash: 'code-lens', language: 'typescript' }
        ],
        nodes: [
          {
            id: 'language-new',
            kind: 'method',
            name: 'new',
            qualifiedName: 'LanguageServer::new',
            filePath: 'cli/lsp/language_server.rs',
            language: 'rust',
            signature: 'fn new(client: Client) -> Self',
            sourceSnippet: 'impl LanguageServer { fn new() { DidChangeBatchQueue::new(); } }',
            calls: ['DidChangeBatchQueue::new']
          },
          {
            id: 'batch-new',
            kind: 'method',
            name: 'new',
            qualifiedName: 'DidChangeBatchQueue::new',
            filePath: 'cli/lsp/language_server.rs',
            language: 'rust',
            signature: 'fn new(uri: Uri) -> Self',
            sourceSnippet: 'impl DidChangeBatchQueue { fn new(uri: Uri) -> Self { } }',
            calls: []
          },
          {
            id: 'test-server-new',
            kind: 'method',
            name: 'new',
            qualifiedName: 'TestServer::new',
            filePath: 'cli/lsp/testing/server.rs',
            language: 'rust',
            signature: 'fn new(client: Client, snapshot: StateSnapshot) -> Self',
            sourceSnippet: 'impl TestServer { fn new() { StateSnapshot::default(); } }',
            calls: []
          },
          {
            id: 'delete-notification',
            kind: 'function',
            name: 'as_delete_notification',
            qualifiedName: 'as_delete_notification',
            filePath: 'cli/lsp/testing/server.rs',
            language: 'rust',
            signature: 'fn as_delete_notification()',
            sourceSnippet: 'fn as_delete_notification() { }',
            calls: []
          },
          {
            id: 'run-cancel',
            kind: 'method',
            name: 'run_cancel_request',
            qualifiedName: 'TestServer::run_cancel_request',
            filePath: 'cli/lsp/testing/server.rs',
            language: 'rust',
            signature: 'fn run_cancel_request()',
            sourceSnippet: 'impl TestServer { fn run_cancel_request() { } }',
            calls: []
          },
          {
            id: 'lsp-testing-api',
            kind: 'function',
            name: 'lsp_testing_api',
            qualifiedName: 'lsp_testing_api',
            filePath: 'tests/integration/lsp_tests.rs',
            language: 'rust',
            signature: 'fn lsp_testing_api()',
            sourceSnippet: 'fn lsp_testing_api() { diagnostic hover snapshot code_lens(); }',
            calls: []
          },
          {
            id: 'code-lens',
            kind: 'interface',
            name: 'E',
            qualifiedName: 'E',
            filePath: 'tests/bench/testdata/code_lens.ts',
            language: 'typescript',
            signature: 'interface E',
            sourceSnippet: 'interface E { e: string; }',
            calls: []
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>> };
    const nodes = payload.nodes ?? [];
    expect(nodes[0]).toMatchObject({
      filePath: 'tests/integration/lsp_tests.rs',
      qualifiedName: 'lsp_testing_api',
      toolRank: 0
    });
    expect(nodes.map((node) => String(node.qualifiedName))).toContain('E');
  });

  test('broad queries include structural context from files that already matched', () => {
    const fixture = snapshot({ includeStructuralContext: true });
    const node = fixture.nodes.find((item) => item.id === 'alpha')!;
    const fusionNode = toFusionNode(node, fixture.nodes);

    expect(fusionNode.content).toContain('context AlphaServiceRuntime');
    expect(fusionNode.content).not.toContain('AutoSyncPipeline');
  });

  test('impact output is derived from snapshot callers and callees', () => {
    const output = formatFastImpact(snapshot(), { project: '/repo', query: 'alpha service', topk: 10, maxTokens: 8000 });

    expect(output).toContain('seed function alphaService src/alpha-service.ts');
    expect(output).toContain('callee function betaAdapter src/beta-adapter.ts');
    expect(output).toContain('caller function alphaService test tests/alpha-service.test.ts');
    expect(output).not.toContain('callers ');
    expect(output).not.toContain('callees ');
    expect(output).not.toContain('calls ');
    expect(output).not.toContain('runAutoSyncOnce');
    expect(output).not.toContain('AutoSyncPipeline');
  });

  test('anchor-rich impact queries expand the seed window to surface caller relations', () => {
    const impactSnapshot: Snapshot = {
      projectPath: '/repo',
      files: [
        { path: 'runtime/worker.rs', contentHash: 'worker', language: 'rust' },
        { path: 'src/noise.rs', contentHash: 'noise', language: 'rust' }
      ],
      nodes: [
        {
          id: 'validate-import-attrs',
          kind: 'function',
          name: 'create_validate_import_attributes_callback',
          qualifiedName: 'create_validate_import_attributes_callback',
          filePath: 'runtime/worker.rs',
          language: 'rust',
          signature: 'fn create_validate_import_attributes_callback()',
          sourceSnippet: 'pub fn create_validate_import_attributes_callback() { }',
          calls: []
        },
        {
          id: 'custom-module-eval',
          kind: 'function',
          name: 'create_custom_module_evaluation_callback',
          qualifiedName: 'create_custom_module_evaluation_callback',
          filePath: 'runtime/worker.rs',
          language: 'rust',
          signature: 'fn create_custom_module_evaluation_callback()',
          sourceSnippet: 'pub fn create_custom_module_evaluation_callback() { }',
          calls: []
        },
        {
          id: 'permissions-stack-trace',
          kind: 'function',
          name: 'create_permissions_stack_trace_callback',
          qualifiedName: 'create_permissions_stack_trace_callback',
          filePath: 'runtime/worker.rs',
          language: 'rust',
          signature: 'fn create_permissions_stack_trace_callback()',
          sourceSnippet: 'pub fn create_permissions_stack_trace_callback() { }',
          calls: []
        },
        {
          id: 'bootstrap-from-options',
          kind: 'method',
          name: 'bootstrap_from_options',
          qualifiedName: 'MainWorker::bootstrap_from_options',
          filePath: 'runtime/worker.rs',
          language: 'rust',
          signature: 'fn bootstrap_from_options()',
          sourceSnippet: 'impl MainWorker { fn bootstrap_from_options() { create_permissions_stack_trace_callback(); } }',
          calls: ['create_permissions_stack_trace_callback']
        },
        {
          id: 'noise',
          kind: 'function',
          name: 'noise',
          qualifiedName: 'noise',
          filePath: 'src/noise.rs',
          language: 'rust',
          signature: 'fn noise()',
          sourceSnippet: 'fn noise() {}',
          calls: []
        }
      ]
    };

    const output = formatFastImpact(impactSnapshot, {
      project: '/repo',
      query: 'runtime/worker.rs create_validate_import_attributes_callback create_custom_module_evaluation_callback create_permissions_stack_trace_callback MainWorker common_runtime',
      topk: 1,
      maxTokens: 8000
    });

    expect(output).toContain('seed function create_permissions_stack_trace_callback runtime/worker.rs');
    expect(output).toContain('caller method MainWorker::bootstrap_from_options runtime/worker.rs');
  });

  test('multi-file impact bundles keep the exact service seed in the seed window', () => {
    const impactSnapshot: Snapshot = {
      projectPath: '/repo',
      files: [
        { path: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py', contentHash: 'route', language: 'python' },
        { path: 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', contentHash: 'service', language: 'python' },
        { path: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', contentHash: 'model', language: 'python' },
        { path: 'airflow-core/src/airflow/api_fastapi/common/dagbag.py', contentHash: 'common', language: 'python' }
      ],
      nodes: [
        {
          id: 'patch-dag-run',
          kind: 'function',
          name: 'patch_dag_run',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py::patch_dag_run',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
          language: 'python',
          signature: 'def patch_dag_run() -> None',
          sourceSnippet: 'def patch_dag_run(): return patch_dag_run_state()',
          calls: ['patch_dag_run_state']
        },
        {
          id: 'patch-dag-run-state',
          kind: 'function',
          name: 'patch_dag_run_state',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py::patch_dag_run_state',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
          language: 'python',
          signature: 'def patch_dag_run_state() -> None',
          sourceSnippet: 'def patch_dag_run_state(): return patch_dag_run_note()',
          calls: ['patch_dag_run_note']
        },
        {
          id: 'patch-dag-run-note',
          kind: 'function',
          name: 'patch_dag_run_note',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py::patch_dag_run_note',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
          language: 'python',
          signature: 'def patch_dag_run_note() -> None',
          sourceSnippet: 'def patch_dag_run_note(): return get_dag_run()',
          calls: ['get_dag_run']
        },
        {
          id: 'clear-dag-run',
          kind: 'function',
          name: 'clear_dag_run',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py::clear_dag_run',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
          language: 'python',
          signature: 'def clear_dag_run() -> None',
          sourceSnippet: 'def clear_dag_run(): return get_dag_run()',
          calls: ['get_dag_run']
        },
        {
          id: 'get-dag-run',
          kind: 'function',
          name: 'get_dag_run',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py::get_dag_run',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
          language: 'python',
          signature: 'def get_dag_run() -> dict',
          sourceSnippet: 'def get_dag_run(): return {"state": "running"}',
          calls: []
        },
        {
          id: 'perform-clear-dag-run',
          kind: 'function',
          name: 'perform_clear_dag_run',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py::perform_clear_dag_run',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py',
          language: 'python',
          signature: 'def perform_clear_dag_run() -> None',
          sourceSnippet: 'def perform_clear_dag_run(): return clear_dag_run()',
          calls: ['clear_dag_run']
        },
        {
          id: 'dag-run-response',
          kind: 'class',
          name: 'DAGRunResponse',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py::DAGRunResponse',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py',
          language: 'python',
          signature: 'class DAGRunResponse',
          sourceSnippet: 'class DAGRunResponse: pass',
          calls: []
        },
        {
          id: 'dag-run-waiter',
          kind: 'class',
          name: 'DagRunWaiter',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/common/dagbag.py::DagRunWaiter',
          filePath: 'airflow-core/src/airflow/api_fastapi/common/dagbag.py',
          language: 'python',
          signature: 'class DagRunWaiter',
          sourceSnippet: 'class DagRunWaiter: pass',
          calls: []
        }
      ]
    };

    const output = formatFastImpact(impactSnapshot, {
      project: '/repo',
      query: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py airflow-core/src/airflow/api_fastapi/common/dagbag.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py patch_dag_run patch_dag_run_state patch_dag_run_note perform_clear_dag_run resolve_run_on_latest_version DAGRunResponse DagRunWaiter',
      topk: 3,
      maxTokens: 8000
    });

    expect(output).toContain('seed function airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py::perform_clear_dag_run airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py');
  });

  test('impact queries preserve seed symbols when deriving affected tests and signals', () => {
    const impactSnapshot: Snapshot = {
      projectPath: '/repo',
      files: [
        { path: 'cli/tools/task.rs', contentHash: 'task', language: 'rust' },
        { path: 'cli/npm.rs', contentHash: 'npm', language: 'rust' },
        { path: 'cli/tools/run/mod.rs', contentHash: 'run', language: 'rust' },
        { path: 'tests/integration/install_tests.rs', contentHash: 'install', language: 'rust' },
        { path: 'tests/integration/lsp_tests.rs', contentHash: 'lsp', language: 'rust' }
      ],
      nodes: [
        {
          id: 'task-runner',
          kind: 'method',
          name: 'run_npm_script',
          qualifiedName: 'TaskRunner::run_npm_script',
          filePath: 'cli/tools/task.rs',
          language: 'rust',
          signature: 'fn run_npm_script(task: &str, env_vars: &HashMap<String, String>)',
          sourceSnippet: 'pub fn run_npm_script(task: &str, env_vars: &HashMap<String, String>) { maybe_npm_install(); }',
          calls: ['maybe_npm_install']
        },
        {
          id: 'install-helper',
          kind: 'function',
          name: 'maybe_npm_install',
          qualifiedName: 'maybe_npm_install',
          filePath: 'cli/tools/run/mod.rs',
          language: 'rust',
          signature: 'fn maybe_npm_install()',
          sourceSnippet: 'pub fn maybe_npm_install() { }',
          calls: []
        },
        {
          id: 'npm-runner',
          kind: 'method',
          name: 'run_single_package_scripts',
          qualifiedName: 'DenoTaskLifeCycleScriptsExecutor::run_single_package_scripts',
          filePath: 'cli/npm.rs',
          language: 'rust',
          signature: 'fn run_single_package_scripts(env_vars: &HashMap<String, String>)',
          sourceSnippet: 'fn run_single_package_scripts(env_vars: &HashMap<String, String>) { }',
          calls: []
        },
        {
          id: 'install-test',
          kind: 'function',
          name: 'install_tests',
          qualifiedName: 'install_tests',
          filePath: 'tests/integration/install_tests.rs',
          language: 'rust',
          signature: 'test install task',
          sourceSnippet: 'test("install task", () => {});',
          calls: []
        },
        {
          id: 'lsp-test',
          kind: 'function',
          name: 'lsp_npm_auto_import_and_quick_fix_byonm',
          qualifiedName: 'lsp_npm_auto_import_and_quick_fix_byonm',
          filePath: 'tests/integration/lsp_tests.rs',
          language: 'rust',
          signature: 'test lsp npm auto import',
          sourceSnippet: 'test("lsp npm auto import", () => {});',
          calls: []
        }
      ]
    };

    const output = formatFastImpact(impactSnapshot, {
      project: '/repo',
      query: 'cli/tools/task.rs TaskRunner::run_npm_script run_single_package_scripts maybe_npm_install resolve_task_node_modules_bin_dirs resolve_custom_commands',
      topk: 1,
      maxTokens: 8000
    });

    expect(output).toContain('signals');
    expect(output).toContain('env');
    expect(output).toContain('test tests/integration/install_tests.rs install_tests');
  });

  test('impact full-json top window keeps the exact runtime seed first and carries affected-test evidence', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'cli/tools/task.rs TaskRunner::run_npm_script run_single_package_scripts maybe_npm_install resolve_task_node_modules_bin_dirs resolve_custom_commands',
        topk: 1,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'cli/tools/task.rs', contentHash: 'task', language: 'rust' },
          { path: 'cli/npm.rs', contentHash: 'npm', language: 'rust' },
          { path: 'cli/tools/test/mod.rs', contentHash: 'tool-test', language: 'rust' },
          { path: 'tests/integration/install_tests.rs', contentHash: 'install', language: 'rust' }
        ],
        nodes: [
          {
            id: 'task-runner',
            kind: 'method',
            name: 'run_npm_script',
            qualifiedName: 'TaskRunner::run_npm_script',
            filePath: 'cli/tools/task.rs',
            language: 'rust',
            signature: 'fn run_npm_script(task: &str, env_vars: &HashMap<String, String>)',
            sourceSnippet: 'pub fn run_npm_script(task: &str, env_vars: &HashMap<String, String>) { maybe_npm_install(); resolve_custom_commands(); }',
            calls: ['maybe_npm_install', 'resolve_task_node_modules_bin_dirs', 'resolve_custom_commands']
          },
          {
            id: 'npm-runner',
            kind: 'method',
            name: 'run_single_package_scripts',
            qualifiedName: 'DenoTaskLifeCycleScriptsExecutor::run_single_package_scripts',
            filePath: 'cli/npm.rs',
            language: 'rust',
            signature: 'fn run_single_package_scripts(env_vars: &HashMap<String, String>)',
            sourceSnippet: 'fn run_single_package_scripts(env_vars: &HashMap<String, String>) { run script shell path }',
            calls: []
          },
          {
            id: 'generic-tools-test',
            kind: 'function',
            name: 'configure_main_worker',
            qualifiedName: 'configure_main_worker',
            filePath: 'cli/tools/test/mod.rs',
            language: 'rust',
            signature: 'fn configure_main_worker()',
            sourceSnippet: 'fn configure_main_worker() { run task test worker }',
            calls: []
          },
          {
            id: 'install-test',
            kind: 'function',
            name: 'install_npm_global_allow_scripts',
            qualifiedName: 'install_npm_global_allow_scripts',
            filePath: 'tests/integration/install_tests.rs',
            language: 'rust',
            signature: 'fn install_npm_global_allow_scripts()',
            sourceSnippet: 'install task run path env script shell node_modules npm maybe_npm_install resolve_custom_commands',
            calls: ['run_npm_script']
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>> };
    const nodes = payload.nodes ?? [];

    expect(nodes[0]).toMatchObject({
      filePath: 'cli/tools/task.rs',
      qualifiedName: 'TaskRunner::run_npm_script'
    });
    expect(nodes.map((node) => String(node.filePath))).toEqual(expect.arrayContaining([
      'cli/tools/task.rs',
      'cli/npm.rs',
      'tests/integration/install_tests.rs'
    ]));
  });

  test('callers and callees commands use the same generic graph index', () => {
    const callers = formatFastGraphNavigation(snapshot(), 'callers', { project: '/repo', query: 'beta adapter', topk: 10, maxTokens: 8000 });
    const callees = formatFastGraphNavigation(snapshot(), 'callees', { project: '/repo', query: 'alpha service', topk: 10, maxTokens: 8000 });

    expect(callers).toContain('caller function alphaService src/alpha-service.ts');
    expect(callees).toContain('callee function betaAdapter src/beta-adapter.ts');
    expect(callers).not.toContain('AutoSyncPipeline');
    expect(callees).not.toContain('runAutoSyncOnce');
  });

  test('graph navigation surfaces barrel-file exports when a module re-exports the seed symbol', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-barrel-'));
    try {
      const indexPath = join(projectPath, 'src/index.ts');
      mkdirSync(dirname(indexPath), { recursive: true });
      writeFileSync(indexPath, [
        'export { runAutoSyncOnce } from "../freshness/auto-sync.js";',
        'export { vectorizeProject } from "../vector/code-to-vectors.js";'
      ].join('\n'));

      const output = formatFastGraphNavigation(snapshot(), 'node', {
        project: projectPath,
        query: 'runAutoSyncOnce',
        topk: 10,
        maxTokens: 8000
      });

      expect(output).toContain('file src/index.ts');
      expect(output).toContain('runAutoSyncOnce');
      expect(output).toContain('vectorizeProject');
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('affected tests are scored from changed file symbols and test source text', () => {
    const output = formatFastAffected(snapshot(), { project: '/repo', query: 'src/alpha-service.ts', topk: 10, maxTokens: 8000 });

    expect(output).toContain('tests/alpha-service.test.ts');
    expect(output).not.toContain('tests/unrelated.test.ts');
    expect(output).not.toContain('tests/cli.test.ts');
  });

  test('full-json capsules append bounded connector-family relation evidence after the top window', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'SourceCouchbase test_streams test_check_connection test_get_cluster test_set_config_values',
        topk: 3,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', contentHash: 'source', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', contentHash: 'tests', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-linkedin-ads/unit_tests/test_source.py', contentHash: 'noise', language: 'python' }
        ],
        nodes: [
          {
            id: 'source-couchbase',
            kind: 'class',
            name: 'SourceCouchbase',
            qualifiedName: 'SourceCouchbase',
            filePath: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py',
            language: 'python',
            signature: 'class SourceCouchbase',
            sourceSnippet: 'class SourceCouchbase: pass',
            calls: []
          },
          ...['name', '_set_config_values', '_get_cluster', 'streams', 'check_connection'].map((name) => ({
            id: `source-couchbase-${name}`,
            kind: 'method',
            name,
            qualifiedName: `SourceCouchbase::${name}`,
            filePath: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py',
            language: 'python',
            signature: `def ${name}(self)`,
            sourceSnippet: `def ${name}(self): return "couchbase bucket stream cluster query"`,
            calls: name === 'streams' ? ['_get_cluster', '_set_config_values'] : []
          })),
          ...['test_streams', 'test_check_connection', 'test_get_cluster', 'test_set_config_values', 'test_ensure_primary_index'].map((name) => ({
            id: `source-couchbase-${name}`,
            kind: 'function',
            name,
            qualifiedName: name,
            filePath: 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py',
            language: 'python',
            signature: `def ${name}()`,
            sourceSnippet: `def ${name}(): assert "couchbase cluster bucket stream query"`,
            calls: [name.replace(/^test_/, '')]
          })),
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `source-couchbase-stream-noise-${index}`,
            kind: index % 3 === 0 ? 'class' : 'method',
            name: index % 3 === 0 ? `CouchbaseNoiseStream${index}` : `noise_stream_${index}`,
            qualifiedName: index % 3 === 0 ? `CouchbaseNoiseStream${index}` : `CouchbaseNoiseStream${index}::noise_stream_${index}`,
            filePath: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/streams.py',
            language: 'python',
            signature: index % 3 === 0 ? `class CouchbaseNoiseStream${index}` : `def noise_stream_${index}(self)`,
            sourceSnippet: 'couchbase stream cluster bucket query unrelated stream implementation',
            calls: []
          })),
          {
            id: 'linkedin-false-friend',
            kind: 'method',
            name: 'test_check_connection',
            qualifiedName: 'TestAllStreams::test_check_connection',
            filePath: 'airbyte-integrations/connectors/source-linkedin-ads/unit_tests/test_source.py',
            language: 'python',
            signature: 'def test_check_connection(self)',
            sourceSnippet: 'def test_check_connection(self): pass',
            calls: ['check']
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>> };
    const nodes = payload.nodes ?? [];
    const qualifiedNames = nodes.map((node) => String(node.qualifiedName));
    const filePaths = nodes.map((node) => String(node.filePath));

    expect(filePaths.slice(0, 3).every((filePath) => filePath.includes('/source-couchbase/'))).toBe(true);
    expect(qualifiedNames).toEqual(expect.arrayContaining([
      'SourceCouchbase',
      'SourceCouchbase::name',
      'SourceCouchbase::_set_config_values',
      'SourceCouchbase::streams',
      'SourceCouchbase::check_connection',
      'test_streams',
      'test_check_connection',
      'test_get_cluster',
      'test_set_config_values',
      'test_ensure_primary_index'
    ]));
    expect(qualifiedNames).not.toContain('TestAllStreams::test_check_connection');
    expect(nodes.length).toBeLessThanOrEqual(23);
    expect(nodes.map((node) => node.toolRank)).toEqual(nodes.map((_, index) => index));
  });

  test('connector runtime capsules keep the queried test stem implementation in the topK window', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'SourceCouchbase test_streams test_check_connection test_get_cluster',
        topk: 3,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', contentHash: 'source', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', contentHash: 'tests', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_full_refresh_stream.py', contentHash: 'noise', language: 'python' }
        ],
        nodes: [
          {
            id: 'source-couchbase',
            kind: 'class',
            name: 'SourceCouchbase',
            qualifiedName: 'SourceCouchbase',
            filePath: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py',
            language: 'python',
            signature: 'class SourceCouchbase',
            sourceSnippet: 'class SourceCouchbase: pass',
            calls: []
          },
          ...['streams', 'check_connection', '_get_cluster'].map((name) => ({
            id: `source-couchbase-${name}`,
            kind: 'method',
            name,
            qualifiedName: `SourceCouchbase::${name}`,
            filePath: 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py',
            language: 'python',
            signature: `def ${name}(self)`,
            sourceSnippet: `def ${name}(self): return "couchbase bucket stream cluster query cursor index"`,
            calls: name === 'streams' ? ['_get_cluster'] : []
          })),
          ...['test_streams', 'test_check_connection', 'test_get_cluster'].map((name) => ({
            id: `source-couchbase-${name}`,
            kind: 'function',
            name,
            qualifiedName: name,
            filePath: 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py',
            language: 'python',
            signature: `def ${name}()`,
            sourceSnippet: `def ${name}(): assert "couchbase cluster bucket stream query"`,
            calls: [name.replace(/^test_/, '')]
          })),
          {
            id: 'source-couchbase-mock-cluster',
            kind: 'function',
            name: 'mock_cluster',
            qualifiedName: 'mock_cluster',
            filePath: 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_full_refresh_stream.py',
            language: 'python',
            signature: 'def mock_cluster()',
            sourceSnippet: 'def mock_cluster(): return "couchbase cluster stream test fixture"',
            calls: []
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>> };
    const topQualifiedNames = (payload.nodes ?? []).slice(0, 3).map((node) => String(node.qualifiedName));

    expect(topQualifiedNames).toContain('SourceCouchbase::streams');
  });

  test('connector-family ranking keeps config runtime test artifacts in topK and evidence', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'SourceFirebaseRealtimeDatabase stream_name_from test_stream_name_from test_records',
        topk: 3,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py', contentHash: 'source', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py', contentHash: 'tests', language: 'python' }
        ],
        nodes: [
          {
            id: 'firebase-source',
            kind: 'class',
            name: 'SourceFirebaseRealtimeDatabase',
            qualifiedName: 'SourceFirebaseRealtimeDatabase',
            filePath: 'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py',
            language: 'python',
            signature: 'class SourceFirebaseRealtimeDatabase',
            sourceSnippet: 'database credentials buffer_size record path',
            calls: []
          },
          ...['stream_name_from', 'check', 'read'].map((name) => ({
            id: `firebase-${name}`,
            kind: 'method',
            name,
            qualifiedName: `SourceFirebaseRealtimeDatabase::${name}`,
            filePath: 'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py',
            language: 'python',
            signature: `def ${name}(self)`,
            sourceSnippet: `def ${name}(self): return "database buffer_size credentials record path"`,
            calls: []
          })),
          {
            id: 'pseudo-client',
            kind: 'class',
            name: 'PseudoClient',
            qualifiedName: 'PseudoClient',
            filePath: 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py',
            language: 'python',
            signature: 'class PseudoClient',
            sourceSnippet: 'class PseudoClient: pass',
            calls: []
          },
          ...['__init__', 'fetch_records'].map((name) => ({
            id: `pseudo-client-${name}`,
            kind: 'method',
            name,
            qualifiedName: `PseudoClient::${name}`,
            filePath: 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py',
            language: 'python',
            signature: `def ${name}(self)`,
            sourceSnippet: `def ${name}(self): return "database buffer_size credentials record path"`,
            calls: []
          })),
          ...['test_stream_name_from', 'test_records'].map((name) => ({
            id: `firebase-${name}`,
            kind: 'function',
            name,
            qualifiedName: name,
            filePath: 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py',
            language: 'python',
            signature: `def ${name}()`,
            sourceSnippet: `def ${name}(): return "database buffer_size credentials record path"`,
            calls: []
          }))
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>> };
    const nodes = payload.nodes ?? [];
    const topFiles = nodes.slice(0, 3).map((node) => String(node.filePath));
    const qualifiedNames = nodes.map((node) => String(node.qualifiedName));

    expect(topFiles).toEqual(expect.arrayContaining([
      'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py',
      'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py'
    ]));
    expect(qualifiedNames).toEqual(expect.arrayContaining([
      'SourceFirebaseRealtimeDatabase::read',
      'PseudoClient',
      'PseudoClient::__init__',
      'PseudoClient::fetch_records',
      'test_records'
    ]));
  });

  test('impact-style connector queries exclude cross-connector test false friends while adding related tests', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'TwilioUsageRecordsStateMigration usage_records test_usage_records_404_handling test_streams TwilioStateMigration',
        topk: 4,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'airbyte-integrations/connectors/source-twilio/components.py', contentHash: 'components', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py', contentHash: 'streams', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py', contentHash: 'usage-404', language: 'python' },
          { path: 'airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py', contentHash: 'noise', language: 'python' }
        ],
        nodes: [
          {
            id: 'twilio-usage-migration',
            kind: 'class',
            name: 'TwilioUsageRecordsStateMigration',
            qualifiedName: 'TwilioUsageRecordsStateMigration',
            filePath: 'airbyte-integrations/connectors/source-twilio/components.py',
            language: 'python',
            signature: 'class TwilioUsageRecordsStateMigration',
            sourceSnippet: 'state parent_slice lookback_window usage_records 404 skipping',
            calls: []
          },
          ...['migrate', 'should_migrate'].map((name) => ({
            id: `twilio-usage-migration-${name}`,
            kind: 'method',
            name,
            qualifiedName: `TwilioUsageRecordsStateMigration::${name}`,
            filePath: 'airbyte-integrations/connectors/source-twilio/components.py',
            language: 'python',
            signature: `def ${name}(self)`,
            sourceSnippet: `def ${name}(self): return "404 skipping state parent_slice lookback_window"`,
            calls: []
          })),
          {
            id: 'twilio-state-migration',
            kind: 'class',
            name: 'TwilioStateMigration',
            qualifiedName: 'TwilioStateMigration',
            filePath: 'airbyte-integrations/connectors/source-twilio/components.py',
            language: 'python',
            signature: 'class TwilioStateMigration',
            sourceSnippet: 'state migration',
            calls: []
          },
          {
            id: 'incremental-twilio-stream',
            kind: 'class',
            name: 'TestIncrementalTwilioStream',
            qualifiedName: 'TestIncrementalTwilioStream',
            filePath: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py',
            language: 'python',
            signature: 'class TestIncrementalTwilioStream',
            sourceSnippet: 'test_streams state parent_slice lookback_window',
            calls: []
          },
          {
            id: 'usage-records-404',
            kind: 'class',
            name: 'TestUsageRecords404Handling',
            qualifiedName: 'TestUsageRecords404Handling',
            filePath: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py',
            language: 'python',
            signature: 'class TestUsageRecords404Handling',
            sourceSnippet: 'usage_records 404 skipping state parent_slice lookback_window',
            calls: []
          },
          ...['test_usage_records_ignores_404_responses', 'test_usage_records_incremental_with_404_handling'].map((name) => ({
            id: `usage-records-404-${name}`,
            kind: 'method',
            name,
            qualifiedName: `TestUsageRecords404Handling::${name}`,
            filePath: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py',
            language: 'python',
            signature: `def ${name}(self)`,
            sourceSnippet: `def ${name}(self): return "404 skipping state parent_slice lookback_window"`,
            calls: ['read']
          })),
          {
            id: 'adjust-false-friend',
            kind: 'function',
            name: 'test_streams',
            qualifiedName: 'test_streams',
            filePath: 'airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py',
            language: 'python',
            signature: 'def test_streams()',
            sourceSnippet: 'def test_streams(): pass',
            calls: ['streams']
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>> };
    const nodes = payload.nodes ?? [];
    const qualifiedNames = nodes.map((node) => String(node.qualifiedName));

    expect(nodes.slice(0, 4).every((node) => String(node.filePath).includes('/source-twilio/'))).toBe(true);
    expect(qualifiedNames).toEqual(expect.arrayContaining([
      'TwilioUsageRecordsStateMigration::migrate',
      'TwilioUsageRecordsStateMigration::should_migrate',
      'TestIncrementalTwilioStream',
      'TestUsageRecords404Handling',
      'TestUsageRecords404Handling::test_usage_records_ignores_404_responses',
      'TestUsageRecords404Handling::test_usage_records_incremental_with_404_handling'
    ]));
    expect(nodes.map((node) => String(node.filePath))).not.toContain('airbyte-integrations/connectors/source-adjust/unit_tests/test_source.py');
  });

  test('registry-fast freshness queries read a single manifest sidecar directly', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const filePath of [
        'src/freshness/auto-sync.ts',
        'src/freshness/manifest.ts',
        'src/freshness/freshness-gate.ts',
        'src/vector/code-to-vectors.ts'
      ]) {
        const absolutePath = join(projectPath, filePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, 'export {};');
      }

      const embeddingProfile = 'local-token-v1:64';
      const chunkerVersion = 'codegraph-node-v3-semantic-bridge';
      const zincgraphPath = join(projectPath, '.zincgraph');
      const manifestPath = join(
        zincgraphPath,
        'manifests',
        `manifest-${createHash('sha256').update(`${embeddingProfile}\0${chunkerVersion}`).digest('hex').slice(0, 16)}.json`
      );

      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        embeddingProfile,
        chunkerVersion,
        entries: [],
        summary: {
          fresh: 7,
          pending: 1,
          stale: 2,
          failed: 0,
          total: 10
        },
        warnings: ['stale files present'],
        isFresh: false
      }, null, 2));

      await main([
        'node',
        'fast-cli',
        'explore',
        'manifest',
        'stale',
        'pending',
        'fresh',
        'freshness',
        '-p',
        projectPath,
        '--topk',
        '10'
      ]);

      expect(log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.route).toBe('registry-fast');
      expect(payload.freshness).toEqual({
        fresh: 7,
        pending: 1,
        stale: 2,
        failed: 0,
        total: 10,
        isFresh: false,
        warnings: [
          expect.stringContaining('using manifest sidecar'),
          'embedding metadata cache missing while manifest sidecar exists',
          'stale files present'
        ]
      });
    } finally {
      log.mockRestore();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('registry fast capsule exposes exact MCP tool symbols', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-registry-'));
    try {
      const registryPath = join(projectPath, 'src/mcp/tool-registry.ts');
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, 'export const placeholder = true;');

      const capsule = await buildRegistryFastCapsule({
        project: projectPath,
        query: 'zincgraph semantic search tool registry',
        topk: 10,
        maxTokens: 8000
      });

      expect(capsule).not.toBeNull();
      const payload = capsule as { route?: string; nodes?: Array<Record<string, unknown>>; evidence?: string };
      expect(payload.route).toBe('registry-fast');
      expect(payload.nodes?.map((node) => node.qualifiedName)).toEqual(expect.arrayContaining([
        'zincgraph_semantic_search',
        'zincgraph_dedup_check'
      ]));
      expect(payload.nodes?.map((node) => node.toolRank)).toEqual([0, 1, 2, 3, 4]);
      expect(payload.evidence).toContain('tool registry');
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('full fast context capsules keep calls as edges and omit documents', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'alphaService',
        topk: 1,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'src/alpha-service.ts', contentHash: 'a', language: 'typescript' },
          { path: 'src/beta-adapter.ts', contentHash: 'b', language: 'typescript' }
        ],
        nodes: [
          {
            id: 'alpha-service',
            kind: 'function',
            name: 'alphaService',
            qualifiedName: 'alphaService',
            filePath: 'src/alpha-service.ts',
            language: 'typescript',
            signature: 'function alphaService()',
            sourceSnippet: 'export function alphaService() { return betaAdapter(); }',
            calls: ['betaAdapter']
          },
          {
            id: 'beta-adapter',
            kind: 'function',
            name: 'betaAdapter',
            qualifiedName: 'betaAdapter',
            filePath: 'src/beta-adapter.ts',
            language: 'typescript',
            signature: 'function betaAdapter()',
            sourceSnippet: 'export function betaAdapter() { return true; }',
            calls: []
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as {
      nodes?: Array<Record<string, unknown>>;
      edges?: Array<Record<string, unknown>>;
      documents?: unknown[];
      evidence?: string;
    };
    expect(payload.nodes?.map((node) => node.qualifiedName)).toEqual(['alphaService']);
    expect(payload.edges).toEqual([
      expect.objectContaining({ source: 'alpha-service', targetName: 'betaAdapter', kind: 'calls' })
    ]);
    expect(payload.documents).toEqual([]);
    expect(payload.evidence).toContain('alpha service');
  });

  test('anchor-rich full-json capsules expand a tiny topk to keep same-file companions', async () => {
    const capsule = await buildFastContextCapsule(
      'explore',
      {
        project: '/repo',
        query: 'tools/update_types_node.ts downloadAndExtractPackages modifySourceFiles extractTarball getWebGlobalNames',
        topk: 2,
        maxTokens: 8000
      },
      {
        projectPath: '/repo',
        files: [
          { path: 'tools/update_types_node.ts', contentHash: 'update-types', language: 'typescript' },
          { path: 'src/noise.ts', contentHash: 'noise', language: 'typescript' }
        ],
        nodes: [
          {
            id: 'download',
            kind: 'function',
            name: 'downloadAndExtractPackages',
            qualifiedName: 'tools/update_types_node.ts::downloadAndExtractPackages',
            filePath: 'tools/update_types_node.ts',
            language: 'typescript',
            signature: 'function downloadAndExtractPackages()',
            sourceSnippet: 'export function downloadAndExtractPackages() { return extractTarball(); }',
            calls: ['extractTarball']
          },
          {
            id: 'modify',
            kind: 'function',
            name: 'modifySourceFiles',
            qualifiedName: 'tools/update_types_node.ts::modifySourceFiles',
            filePath: 'tools/update_types_node.ts',
            language: 'typescript',
            signature: 'function modifySourceFiles()',
            sourceSnippet: 'export function modifySourceFiles() { return getWebGlobalNames(); }',
            calls: ['getWebGlobalNames']
          },
          {
            id: 'extract',
            kind: 'function',
            name: 'extractTarball',
            qualifiedName: 'tools/update_types_node.ts::extractTarball',
            filePath: 'tools/update_types_node.ts',
            language: 'typescript',
            signature: 'function extractTarball()',
            sourceSnippet: 'export function extractTarball() { return true; }',
            calls: []
          },
          {
            id: 'globals',
            kind: 'function',
            name: 'getWebGlobalNames',
            qualifiedName: 'tools/update_types_node.ts::getWebGlobalNames',
            filePath: 'tools/update_types_node.ts',
            language: 'typescript',
            signature: 'function getWebGlobalNames()',
            sourceSnippet: 'export function getWebGlobalNames() { return true; }',
            calls: []
          },
          {
            id: 'noise',
            kind: 'function',
            name: 'noise',
            qualifiedName: 'src/noise.ts::noise',
            filePath: 'src/noise.ts',
            language: 'typescript',
            signature: 'function noise()',
            sourceSnippet: 'export function noise() { return true; }',
            calls: []
          }
        ]
      }
    );

    expect(capsule).not.toBeNull();
    const payload = capsule as { nodes?: Array<Record<string, unknown>>; evidence?: string };
    expect(payload.nodes).toHaveLength(4);
    expect(payload.nodes?.[0]?.qualifiedName).toBe('tools/update_types_node.ts::downloadAndExtractPackages');
    expect(payload.nodes?.map((node) => node.toolRank)).toEqual([0, 1, 2, 3]);
    expect(payload.nodes?.map((node) => node.qualifiedName)).toEqual(expect.arrayContaining([
      'tools/update_types_node.ts::downloadAndExtractPackages',
      'tools/update_types_node.ts::modifySourceFiles',
      'tools/update_types_node.ts::extractTarball',
      'tools/update_types_node.ts::getWebGlobalNames'
    ]));
    expect(payload.evidence).toContain('download and extract packages');
  });

  test('registry fast path does not hijack behavior review queries', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-behavior-'));
    try {
      const registryPath = join(projectPath, 'src/mcp/tool-registry.ts');
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, 'export const placeholder = true;');

      const capsule = await buildRegistryFastCapsule({
        project: projectPath,
        query: 'semantic dedup graph review',
        topk: 10,
        maxTokens: 8000
      });

      expect(capsule).toBeNull();
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('semantic augment results honor structured path filters', async () => {
    semanticAugmentMock.openCollection.mockClear();
    semanticAugmentMock.query.mockClear();

    const nodes = [
      {
        id: 'compression-node',
        kind: 'function',
        name: 'createFeedbackAwarePolicy',
        qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
        filePath: 'src/compression/ranking-adjuster.ts',
        language: 'typescript',
        signature: 'function createFeedbackAwarePolicy(): DynamicFusionPolicy',
        calls: []
      },
      {
        id: 'noise-node',
        kind: 'function',
        name: 'createVectorDedupSearch',
        qualifiedName: 'src/behavior/dedup-check.ts::createVectorDedupSearch',
        filePath: 'src/behavior/dedup-check.ts',
        language: 'typescript',
        signature: 'function createVectorDedupSearch(): DedupCheckerDependencies["search"]',
        calls: []
      }
    ] satisfies Snapshot['nodes'];

    const result = await readFastSemanticAugments(
      '/repo',
      'which code decides priority ordering when search results are mixed from multiple sources path:src/compression',
      5,
      nodes
    );

    expect(result.vectorHits).toBe(1);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.filePath).toBe('src/compression/ranking-adjuster.ts');
    expect(semanticAugmentMock.openCollection).toHaveBeenCalledTimes(1);
    expect(semanticAugmentMock.query).toHaveBeenCalledTimes(1);
  });

  test('semantic-routing bridge fast path can surface intent-router without vector search', async () => {
    semanticAugmentMock.openCollection.mockClear();
    semanticAugmentMock.query.mockClear();

    const nodes = [
      {
        id: 'compression-node',
        kind: 'function',
        name: 'createFeedbackAwarePolicy',
        qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
        filePath: 'src/compression/ranking-adjuster.ts',
        language: 'typescript',
        signature: 'function createFeedbackAwarePolicy(): DynamicFusionPolicy',
        calls: []
      },
      {
        id: 'router-node',
        kind: 'function',
        name: 'parseFusionQuery',
        qualifiedName: 'src/fusion/intent-router.ts::parseFusionQuery',
        filePath: 'src/fusion/intent-router.ts',
        language: 'typescript',
        signature: 'function parseFusionQuery(query: string): ParsedFusionQuery',
        docstring: 'Decide priority ordering when search results are mixed from multiple sources.',
        sourceSnippet: 'export function parseFusionQuery(query: string): ParsedFusionQuery { return routeParsedQuery(query); }',
        calls: ['routeParsedQuery', 'queryTerms']
      }
    ] satisfies Snapshot['nodes'];

    const result = await readFastSemanticAugments(
      '/repo',
      'which code decides priority ordering when search results are mixed from multiple sources path:src/compression',
      5,
      nodes,
      { skipVectorSearch: true }
    );

    expect(result.vectorHits).toBe(0);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.filePath).toBe('src/fusion/intent-router.ts');
    expect(result.nodes[0]?.qualifiedName).toContain('parseFusionQuery');
    expect(result.nodes[0]?.content).toContain('priority ordering');
    expect(semanticAugmentMock.openCollection).not.toHaveBeenCalled();
    expect(semanticAugmentMock.query).not.toHaveBeenCalled();
  });

});
