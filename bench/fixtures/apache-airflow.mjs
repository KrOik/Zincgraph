import { makeCase, relation } from './_shared.mjs';

export default [
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-rh-conn-bulk',
    family: 'retrievalHeavy',
    query: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py airflow-core/src/airflow/api_fastapi/core_api/services/public/connections.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/connections.py get_connection get_connections post_connection bulk_connections handle_bulk_update update_orm_from_pydantic ConnectionResponse ConnectionCollectionResponse',
    difficulty: 'hard',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/public/connections.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/connections.py'
    ],
    goldenSymbols: [
      'get_connection',
      'get_connections',
      'post_connection',
      'bulk_connections',
      'handle_bulk_update',
      'update_orm_from_pydantic',
      'ConnectionResponse',
      'ConnectionCollectionResponse'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py', 'get_connection'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py', 'get_connections'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py', 'post_connection'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py', 'bulk_connections'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/connections.py', 'handle_bulk_update'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/connections.py', 'update_orm_from_pydantic'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/connections.py', 'ConnectionResponse'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/connections.py', 'ConnectionCollectionResponse')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['bulk_update', 'password', 'extra', 'merge', 'team_name'],
    forbiddenFalsePositives: [],
    goldenTests: ['airflow-core/tests/unit/api_fastapi/core_api/routes/public/test_connections.py'],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/connections.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/public/connections.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/connections.py'
    ]
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-rh-dagrun-clear',
    family: 'retrievalHeavy',
    query: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py airflow-core/src/airflow/api_fastapi/common/dagbag.py get_dag_run delete_dag_run patch_dag_run patch_dag_run_state patch_dag_run_note perform_clear_dag_run resolve_run_on_latest_version DAGRunResponse',
    difficulty: 'hard',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/common/dagbag.py'
    ],
    goldenSymbols: [
      'get_dag_run',
      'delete_dag_run',
      'patch_dag_run',
      'patch_dag_run_state',
      'patch_dag_run_note',
      'perform_clear_dag_run',
      'resolve_run_on_latest_version',
      'DAGRunResponse'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py', 'get_dag_run'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py', 'delete_dag_run'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py', 'patch_dag_run'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', 'patch_dag_run_state'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', 'patch_dag_run_note'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', 'perform_clear_dag_run'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/common/dagbag.py', 'resolve_run_on_latest_version'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'DAGRunResponse')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['run_on_latest_version', 'only_new', 'only_failed', 'patch_dag_run_state', 'note'],
    forbiddenFalsePositives: [],
    goldenTests: [
      'airflow-core/tests/unit/api_fastapi/core_api/routes/public/test_dag_run.py',
      'airflow-core/tests/unit/api_fastapi/core_api/datamodels/test_dag_run.py'
    ],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/common/dagbag.py'
    ]
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-flow-dags-list',
    family: 'flow',
    query: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dags.py airflow-core/src/airflow/api_fastapi/common/db/dags.py airflow-core/src/airflow/api_fastapi/common/db/common.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/dags.py get_dags generate_dag_with_latest_run_query paginated_select apply_filters_to_select DAGCollectionResponse',
    difficulty: 'medium',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dags.py',
      'airflow-core/src/airflow/api_fastapi/common/db/dags.py',
      'airflow-core/src/airflow/api_fastapi/common/db/common.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dags.py'
    ],
    goldenSymbols: [
      'get_dags',
      'generate_dag_with_latest_run_query',
      'paginated_select',
      'apply_filters_to_select',
      'DAGCollectionResponse'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dags.py', 'get_dags'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/common/db/dags.py', 'generate_dag_with_latest_run_query'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/common/db/common.py', 'paginated_select'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/common/db/common.py', 'apply_filters_to_select'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dags.py', 'DAGCollectionResponse')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['latest_run', 'readable_dags_filter', 'order_by', 'paginate', 'total_entries'],
    forbiddenFalsePositives: [],
    goldenTests: [
      'airflow-core/tests/unit/api_fastapi/core_api/routes/public/test_dags.py',
      'airflow-core/tests/unit/api_fastapi/common/db/test_dags.py'
    ],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dags.py',
      'airflow-core/src/airflow/api_fastapi/common/db/dags.py',
      'airflow-core/src/airflow/api_fastapi/common/db/common.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dags.py'
    ]
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-flow-structure',
    family: 'flow',
    query: 'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py airflow-core/src/airflow/api_fastapi/core_api/services/ui/task_group.py airflow-core/src/airflow/utils/dag_edges.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py structure_data get_upstream_assets bind_output_assets_to_tasks task_group_to_dict dag_edges StructureDataResponse',
    difficulty: 'medium',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/ui/task_group.py',
      'airflow-core/src/airflow/utils/dag_edges.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py'
    ],
    goldenSymbols: [
      'structure_data',
      'get_upstream_assets',
      'bind_output_assets_to_tasks',
      'task_group_to_dict',
      'dag_edges',
      'StructureDataResponse'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py', 'structure_data'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py', 'get_upstream_assets'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py', 'bind_output_assets_to_tasks'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/task_group.py', 'task_group_to_dict'),
      relation('contains', 'airflow-core/src/airflow/utils/dag_edges.py', 'dag_edges'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py', 'StructureDataResponse')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['structure_data', 'asset_condition', 'resolved_from_alias', 'topological_sort', 'dag_edges'],
    forbiddenFalsePositives: [],
    goldenTests: ['airflow-core/tests/unit/api_fastapi/core_api/routes/ui/test_structure.py'],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/ui/task_group.py',
      'airflow-core/src/airflow/utils/dag_edges.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py'
    ],
    requiredConsequenceTerms: ['nodes', 'edges', 'asset', 'dependency']
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-struct-dagrun-clear',
    family: 'structure',
    query: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py PartitionSelectorMixin BaseDAGRunClear DAGRunClearBody BulkDAGRunClearBody ClearPartitionsBody ClearPartitionsResponse',
    difficulty: 'medium',
    goldenFiles: ['airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py'],
    goldenSymbols: [
      'PartitionSelectorMixin',
      'BaseDAGRunClear',
      'DAGRunClearBody',
      'BulkDAGRunClearBody',
      'ClearPartitionsBody',
      'ClearPartitionsResponse'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'PartitionSelectorMixin'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'BaseDAGRunClear'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'DAGRunClearBody'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'BulkDAGRunClearBody'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'ClearPartitionsBody'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'ClearPartitionsResponse')
    ],
    requiredTopK: 4,
    requiredEvidenceTerms: ['clear_partitions', 'partition_key', 'partition_date_start', 'partition_date_end', 'only_new'],
    forbiddenFalsePositives: [],
    goldenTests: [
      'airflow-core/tests/unit/api_fastapi/core_api/datamodels/test_dag_run.py',
      'airflow-core/tests/unit/api_fastapi/core_api/routes/public/test_dag_run.py'
    ],
    goldenRuntimeArtifacts: ['airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py'],
    requiredConsequenceTerms: ['partition', 'selector', 'window', 'exclusive']
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-struct-assets',
    family: 'structure',
    query: 'airflow-core/src/airflow/assets/evaluation.py airflow-core/src/airflow/assets/manager.py airflow-core/src/airflow/models/asset.py AssetEvaluator AssetManager resolve_ref_to_asset expand_alias_to_assets',
    difficulty: 'medium',
    goldenFiles: [
      'airflow-core/src/airflow/assets/evaluation.py',
      'airflow-core/src/airflow/assets/manager.py',
      'airflow-core/src/airflow/models/asset.py'
    ],
    goldenSymbols: [
      'AssetEvaluator',
      'AssetEvaluator._resolve_asset_ref',
      'AssetEvaluator._resolve_asset_alias',
      'AssetEvaluator.run',
      'AssetManager',
      'resolve_ref_to_asset',
      'expand_alias_to_assets'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/assets/evaluation.py', 'AssetEvaluator'),
      relation('contains', 'airflow-core/src/airflow/assets/evaluation.py', 'AssetEvaluator._resolve_asset_ref'),
      relation('contains', 'airflow-core/src/airflow/assets/evaluation.py', 'AssetEvaluator._resolve_asset_alias'),
      relation('contains', 'airflow-core/src/airflow/assets/evaluation.py', 'AssetEvaluator.run'),
      relation('contains', 'airflow-core/src/airflow/assets/manager.py', 'AssetManager'),
      relation('contains', 'airflow-core/src/airflow/models/asset.py', 'resolve_ref_to_asset'),
      relation('contains', 'airflow-core/src/airflow/models/asset.py', 'expand_alias_to_assets')
    ],
    requiredTopK: 4,
    requiredEvidenceTerms: ['singledispatchmethod', 'resolve_ref_to_asset', 'expand_alias_to_assets', 'asset-alias', 'allow_global_consumers'],
    forbiddenFalsePositives: [],
    goldenTests: [
      'airflow-core/tests/unit/assets/test_evaluation.py',
      'airflow-core/tests/unit/assets/test_manager.py'
    ],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/assets/evaluation.py',
      'airflow-core/src/airflow/assets/manager.py',
      'airflow-core/src/airflow/models/asset.py'
    ]
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-impact-exec-conn',
    family: 'impact',
    query: 'airflow-core/src/airflow/api_fastapi/execution_api/routes/connections.py airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection.py get_connection ConnectionResponse',
    difficulty: 'hard',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/execution_api/routes/connections.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection.py'
    ],
    goldenSymbols: ['get_connection', 'ConnectionResponse'],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/execution_api/routes/connections.py', 'get_connection'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection.py', 'ConnectionResponse')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['conn_id', 'extra', 'password', 'access_denied', 'not_found'],
    forbiddenFalsePositives: [],
    goldenTests: ['airflow-core/tests/unit/api_fastapi/execution_api/versions/head/test_connections.py'],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/execution_api/routes/connections.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection.py'
    ],
    requiredConsequenceTerms: ['redact', 'extra', 'password', 'team_name'],
    impactRequired: true
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-impact-dagrun-patch',
    family: 'impact',
    query: 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py airflow-core/src/airflow/api_fastapi/common/dagbag.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py patch_dag_run patch_dag_run_state patch_dag_run_note perform_clear_dag_run resolve_run_on_latest_version DAGRunResponse DagRunWaiter',
    difficulty: 'hard',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/common/dagbag.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py'
    ],
    goldenSymbols: [
      'patch_dag_run',
      'patch_dag_run_state',
      'patch_dag_run_note',
      'perform_clear_dag_run',
      'resolve_run_on_latest_version',
      'DagRunWaiter',
      'DAGRunResponse'
    ],
    goldenRelations: [
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py', 'patch_dag_run'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', 'patch_dag_run_state'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', 'patch_dag_run_note'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py', 'perform_clear_dag_run'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/common/dagbag.py', 'resolve_run_on_latest_version'),
      relation('contains', 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py', 'DAGRunResponse')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['queued', 'success', 'failed', 'listener', 'note'],
    forbiddenFalsePositives: [],
    goldenTests: [
      'airflow-core/tests/unit/api_fastapi/core_api/routes/public/test_dag_run.py',
      'airflow-core/tests/unit/api_fastapi/core_api/datamodels/test_dag_run.py'
    ],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/core_api/services/public/dag_run.py',
      'airflow-core/src/airflow/api_fastapi/common/dagbag.py',
      'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py'
    ],
    requiredConsequenceTerms: ['queued', 'failed', 'success', 'listener', 'note'],
    impactRequired: true
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-fresh-conn-tests',
    family: 'freshness',
    query: 'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py airflow-core/src/airflow/api_fastapi/execution_api/routes/connection_tests.py airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection_test.py airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_04_06.py AddConnectionTestEndpoint AddVariableKeysEndpoint AddTaskAndAssetStateStoreEndpoints get_connection_test_connection patch_connection_test ConnectionTestResultBody',
    difficulty: 'hard',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/routes/connection_tests.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection_test.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_04_06.py'
    ],
    goldenSymbols: [
      'AddConnectionTestEndpoint',
      'AddVariableKeysEndpoint',
      'AddTaskAndAssetStateStoreEndpoints',
      'get_connection_test_connection',
      'patch_connection_test',
      'ConnectionTestResultBody'
    ],
    requiredTopK: 4,
    requiredEvidenceTerms: ['didnt_exist', 'connection-tests', 'versionedapirouter', 'store/asset', 'variables/keys'],
    forbiddenFalsePositives: [],
    freshnessSetup: {
      newTargets: [
        'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py',
        'airflow-core/src/airflow/api_fastapi/execution_api/routes/connection_tests.py',
        'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection_test.py'
      ],
      staleTargets: [
        'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_04_06.py',
        'AddDagRunDetailEndpoint',
        'AddPartitionKeyField'
      ]
    },
    goldenTests: ['airflow-core/tests/unit/api_fastapi/execution_api/versions/v2026_06_30/test_connection_tests.py'],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/routes/connection_tests.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/connection_test.py'
    ],
    requiredConsequenceTerms: ['added', 'removed', 'endpoint', 'version']
  }),
  makeCase({
    repoId: 'apache-airflow',
    tier: 'core',
    queryId: 'af-core-fresh-exec-schema',
    family: 'freshness',
    query: 'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py airflow-core/src/airflow/api_fastapi/execution_api/datamodels/dagrun.py airflow-core/src/airflow/api_fastapi/execution_api/datamodels/taskinstance.py airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_04_06.py AddTeamNameField AddPartitionDateField AddTaskInstanceQueueField AddRetryPolicyFields AddAwaitingInputStatePayload',
    difficulty: 'hard',
    goldenFiles: [
      'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/dagrun.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/taskinstance.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_04_06.py'
    ],
    goldenSymbols: [
      'AddTeamNameField',
      'AddPartitionDateField',
      'AddTaskInstanceQueueField',
      'AddRetryPolicyFields',
      'AddAwaitingInputStatePayload'
    ],
    requiredTopK: 4,
    requiredEvidenceTerms: ['team_name', 'partition_date', 'queue', 'didnt_exist'],
    forbiddenFalsePositives: [],
    freshnessSetup: {
      newTargets: [
        'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py',
        'AddTeamNameField',
        'AddPartitionDateField'
      ],
      staleTargets: [
        'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_04_06.py',
        'AddPartitionKeyField',
        'AddRunAfterField'
      ]
    },
    goldenTests: [
      'airflow-core/tests/unit/api_fastapi/execution_api/versions/v2026_04_06/test_dag_runs.py',
      'airflow-core/tests/unit/api_fastapi/execution_api/versions/v2026_06_30/test_task_instances.py'
    ],
    goldenRuntimeArtifacts: [
      'airflow-core/src/airflow/api_fastapi/execution_api/versions/v2026_06_30.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/dagrun.py',
      'airflow-core/src/airflow/api_fastapi/execution_api/datamodels/taskinstance.py'
    ],
    requiredConsequenceTerms: ['team_name', 'partition_date', 'queue', 'version']
  })
];
