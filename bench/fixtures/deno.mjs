import { makeCase, relation } from './_shared.mjs';

export default [
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-rh-file-fetcher',
    family: 'retrievalHeavy',
    query: 'cli/file_fetcher.rs create_cli_file_fetcher BlobStoreAdapter PermissionedFileFetcherOptions',
    difficulty: 'medium',
    goldenFiles: ['cli/file_fetcher.rs', 'libs/resolver/file_fetcher.rs'],
    goldenSymbols: ['create_cli_file_fetcher', 'BlobStoreAdapter', 'PermissionedFileFetcherOptions'],
    goldenRelations: [
      relation('contains', 'cli/file_fetcher.rs', 'create_cli_file_fetcher'),
      relation('contains', 'cli/file_fetcher.rs', 'BlobStoreAdapter'),
      relation('contains', 'libs/resolver/file_fetcher.rs', 'PermissionedFileFetcherOptions')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['permissioned', 'fetcher', 'blobstore', 'httpclient', 'download'],
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-rh-import-attrs',
    family: 'retrievalHeavy',
    query: 'runtime/worker.rs create_validate_import_attributes_callback create_custom_module_evaluation_callback create_permissions_stack_trace_callback',
    difficulty: 'medium',
    goldenFiles: ['runtime/worker.rs'],
    goldenSymbols: [
      'create_validate_import_attributes_callback',
      'create_custom_module_evaluation_callback',
      'create_permissions_stack_trace_callback'
    ],
    goldenRelations: [
      relation('contains', 'runtime/worker.rs', 'create_validate_import_attributes_callback'),
      relation('contains', 'runtime/worker.rs', 'create_custom_module_evaluation_callback'),
      relation('contains', 'runtime/worker.rs', 'create_permissions_stack_trace_callback')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['import', 'attributes', 'raw', 'module', 'css'],
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-flow-startup',
    family: 'flow',
    query: 'cli/main.rs cli/lib.rs resolve_flags_and_init run_subcommand wait_for_start init_v8 flags_from_vec_with_initial_cwd',
    difficulty: 'hard',
    goldenFiles: ['cli/main.rs', 'cli/lib.rs'],
    goldenSymbols: [
      'resolve_flags_and_init',
      'run_subcommand',
      'init_v8',
      'wait_for_start',
      'flags_from_vec_with_initial_cwd'
    ],
    goldenRelations: [
      relation('contains', 'cli/main.rs', 'main'),
      relation('contains', 'cli/lib.rs', 'resolve_flags_and_init'),
      relation('contains', 'cli/lib.rs', 'run_subcommand'),
      relation('contains', 'cli/lib.rs', 'wait_for_start'),
      relation('contains', 'cli/lib.rs', 'init_v8')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['startup', 'clap', 'subcommand', 'v8', 'control'],
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-flow-runtime-wiring',
    family: 'flow',
    query: 'runtime/worker.rs create_validate_import_attributes_callback create_custom_module_evaluation_callback create_permissions_stack_trace_callback MainWorker WorkerServiceOptions common_runtime',
    difficulty: 'hard',
    goldenFiles: ['runtime/worker.rs'],
    goldenSymbols: [
      'common_runtime',
      'create_validate_import_attributes_callback',
      'create_custom_module_evaluation_callback',
      'create_permissions_stack_trace_callback',
      'MainWorker',
      'WorkerServiceOptions'
    ],
    goldenRelations: [
      relation('contains', 'runtime/worker.rs', 'common_runtime'),
      relation('contains', 'runtime/worker.rs', 'create_validate_import_attributes_callback'),
      relation('contains', 'runtime/worker.rs', 'create_custom_module_evaluation_callback'),
      relation('contains', 'runtime/worker.rs', 'create_permissions_stack_trace_callback')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['module', 'attributes', 'stack', 'trace', 'jsruntime'],
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-structure-cachedb',
    family: 'structure',
    query: 'cli/cache/cache_db.rs CacheDBConfiguration CacheDB CacheFailure ConnectionState create_combined_sql open_connection initialize_connection handle_failure_mode log_failure_mode is_wsl1',
    difficulty: 'hard',
    goldenFiles: ['cli/cache/cache_db.rs'],
    goldenSymbols: [
      'CacheDBConfiguration',
      'CacheDB',
      'CacheFailure',
      'ConnectionState',
      'create_combined_sql',
      'open_connection'
    ],
    goldenRelations: [
      relation('contains', 'cli/cache/cache_db.rs', 'CacheDBConfiguration'),
      relation('contains', 'cli/cache/cache_db.rs', 'CacheDB'),
      relation('contains', 'cli/cache/cache_db.rs', 'CacheFailure'),
      relation('contains', 'cli/cache/cache_db.rs', 'ConnectionState'),
      relation('contains', 'cli/cache/cache_db.rs', 'create_combined_sql'),
      relation('contains', 'cli/cache/cache_db.rs', 'open_connection'),
      relation('contains', 'cli/cache/cache_db.rs', 'initialize_connection'),
      relation('contains', 'cli/cache/cache_db.rs', 'handle_failure_mode'),
      relation('contains', 'cli/cache/cache_db.rs', 'log_failure_mode')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['wal', 'truncate', 'blackhole', 'in-memory', 'wsl'],
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-structure-lsp-state',
    family: 'structure',
    query: 'cli/lsp/language_server.rs LanguageServerTaskQueue DidChangeBatchQueue StateSnapshot to_lsp_range did_save did_change_watched_files did_change_configuration did_close notebook_did_change',
    difficulty: 'hard',
    goldenFiles: ['cli/lsp/language_server.rs'],
    goldenSymbols: [
      'LanguageServer',
      'DidChangeBatchQueue',
      'StateSnapshot',
      'LanguageServerTaskQueue',
      'to_lsp_range'
    ],
    goldenRelations: [
      relation('contains', 'cli/lsp/language_server.rs', 'LanguageServer'),
      relation('contains', 'cli/lsp/language_server.rs', 'DidChangeBatchQueue'),
      relation('contains', 'cli/lsp/language_server.rs', 'StateSnapshot'),
      relation('contains', 'cli/lsp/language_server.rs', 'LanguageServerTaskQueue')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['snapshot', 'workspace', 'queue', 'diagnostic', 'lsp'],
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-impact-task-runner',
    family: 'impact',
    query: 'cli/task_runner.rs run_task get_script_with_args prepare_env_vars resolve_custom_commands resolve_npm_commands_from_bin_dir tests/integration/task_tests.rs tests/config/deno.json',
    difficulty: 'hard',
    goldenFiles: ['cli/task_runner.rs'],
    goldenSymbols: [
      'run_task',
      'prepare_env_vars',
      'resolve_custom_commands',
      'resolve_npm_commands_from_bin_dir',
      'get_script_with_args'
    ],
    goldenRelations: [
      relation('contains', 'cli/task_runner.rs', 'run_task'),
      relation('contains', 'cli/task_runner.rs', 'prepare_env_vars'),
      relation('contains', 'cli/task_runner.rs', 'get_script_with_args'),
      relation('contains', 'cli/task_runner.rs', 'resolve_custom_commands')
    ],
    requiredTopK: 8,
    requiredEvidenceTerms: ['task', 'path', 'env', 'node_modules', 'shell'],
    goldenTests: ['tests/integration/task_tests.rs'],
    goldenRuntimeArtifacts: ['tests/config/deno.json'],
    requiredConsequenceTerms: ['task', 'run', 'path', 'env', 'script'],
    impactRequired: true,
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-impact-lsp',
    family: 'impact',
    query: 'cli/lsp/language_server.rs cli/lsp/testing/server.rs LanguageServer DidChangeBatchQueue StateSnapshot TestServer as_delete_notification run_cancel_request tests/integration/lsp_tests.rs tests/bench/testdata/code_lens.ts',
    difficulty: 'hard',
    goldenFiles: ['cli/lsp/language_server.rs', 'cli/lsp/testing/server.rs'],
    goldenSymbols: ['LanguageServer', 'DidChangeBatchQueue', 'StateSnapshot', 'TestServer', 'as_delete_notification'],
    goldenRelations: [
      relation('contains', 'cli/lsp/language_server.rs', 'LanguageServer'),
      relation('contains', 'cli/lsp/language_server.rs', 'DidChangeBatchQueue'),
      relation('contains', 'cli/lsp/language_server.rs', 'StateSnapshot'),
      relation('contains', 'cli/lsp/testing/server.rs', 'TestServer'),
      relation('contains', 'cli/lsp/testing/server.rs', 'as_delete_notification')
    ],
    requiredTopK: 8,
    requiredEvidenceTerms: ['lsp', 'diagnostic', 'hover', 'snapshot', 'code'],
    goldenTests: ['tests/integration/lsp_tests.rs'],
    goldenRuntimeArtifacts: ['tests/bench/testdata/code_lens.ts'],
    requiredConsequenceTerms: ['lsp', 'diagnostic', 'hover', 'snapshot', 'code'],
    impactRequired: true,
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-fresh-import-map',
    family: 'freshness',
    query: 'tools/update_import_map_for_tests.ts sortObjectByKey rootImportMap coreImportMap denoConfig import_map.json tools/core_import_map.json',
    difficulty: 'medium',
    goldenFiles: [
      'tools/update_import_map_for_tests.ts',
      'import_map.json',
      'tools/core_import_map.json'
    ],
    goldenSymbols: ['sortObjectByKey', 'rootImportMap', 'coreImportMap', 'denoConfig'],
    goldenRelations: [
      relation('contains', 'tools/update_import_map_for_tests.ts', 'sortObjectByKey'),
      relation('contains', 'tools/update_import_map_for_tests.ts', 'rootImportMap'),
      relation('contains', 'tools/update_import_map_for_tests.ts', 'coreImportMap')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['import', 'map', 'std', 'workspace', 'write'],
    requiredConsequenceTerms: ['refresh', 'generated', 'import', 'map'],
    freshnessSetup: {
      newTargets: ['import_map.json', 'tools/core_import_map.json'],
      staleTargets: []
    }
  }),
  makeCase({
    repoId: 'deno',
    tier: 'core',
    queryId: 'deno-fresh-node-types',
    family: 'freshness',
    query: 'tools/update_types_node.ts downloadAndExtractPackages modifySourceFiles extractTarball getWebGlobalNames cli/tsc/dts/node/README.md cli/tsc/dts/node/index.d.cts cli/tsc/dts/node/undici/index.d.ts',
    difficulty: 'medium',
    goldenFiles: [
      'tools/update_types_node.ts',
      'cli/tsc/dts/node/README.md',
      'cli/tsc/dts/node/index.d.cts',
      'cli/tsc/dts/node/undici/index.d.ts'
    ],
    goldenSymbols: ['downloadAndExtractPackages', 'modifySourceFiles', 'extractTarball', 'getWebGlobalNames'],
    goldenRelations: [
      relation('contains', 'tools/update_types_node.ts', 'downloadAndExtractPackages'),
      relation('contains', 'tools/update_types_node.ts', 'modifySourceFiles'),
      relation('contains', 'tools/update_types_node.ts', 'extractTarball'),
      relation('contains', 'tools/update_types_node.ts', 'getWebGlobalNames')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['download', 'extract', 'types', 'undici', 'declaration'],
    requiredConsequenceTerms: ['generated', 'node', 'types', 'undici', 'refresh'],
    freshnessSetup: {
      newTargets: [
        'cli/tsc/dts/node/README.md',
        'cli/tsc/dts/node/index.d.cts',
        'cli/tsc/dts/node/undici/index.d.ts'
      ],
      staleTargets: []
    }
  })
];
