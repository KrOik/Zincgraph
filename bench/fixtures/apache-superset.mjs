import { makeCase, relation } from './_shared.mjs';

export default [
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-rh-guest-token-revocation',
    family: 'retrievalHeavy',
    query: 'superset/security/guest_token.py superset/security/manager.py tests/unit_tests/security/guest_token_revocation_test.py tests/integration_tests/security/guest_token_security_tests.py build_guest_token_audit_payload get_current_guest_token_revocation_version bump_guest_token_revocation_version get_guest_user_from_token validate_guest_token_resources GuestUser SupersetSecurityManager',
    difficulty: 'hard',
    goldenFiles: [
      'superset/security/guest_token.py',
      'superset/security/manager.py',
      'tests/unit_tests/security/guest_token_revocation_test.py',
      'tests/integration_tests/security/guest_token_security_tests.py'
    ],
    goldenSymbols: [
      'build_guest_token_audit_payload',
      'get_current_guest_token_revocation_version',
      'bump_guest_token_revocation_version',
      'get_guest_user_from_token',
      'validate_guest_token_resources',
      'GuestUser',
      'SupersetSecurityManager'
    ],
    goldenRelations: [
      relation('contains', 'superset/security/guest_token.py', 'build_guest_token_audit_payload'),
      relation('contains', 'superset/security/guest_token.py', 'get_current_guest_token_revocation_version'),
      relation('contains', 'superset/security/guest_token.py', 'bump_guest_token_revocation_version'),
      relation('contains', 'superset/security/guest_token.py', 'get_guest_user_from_token'),
      relation('contains', 'superset/security/manager.py', 'SupersetSecurityManager'),
      relation('contains', 'tests/unit_tests/security/guest_token_revocation_test.py', 'validate_guest_token_resources')
    ],
    requiredTopK: 8,
    requiredEvidenceTerms: ['guest', 'token', 'revocation', 'audit', 'security'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'tests/unit_tests/security/guest_token_revocation_test.py',
      'tests/integration_tests/security/guest_token_security_tests.py'
    ]
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-rh-sqlquery-render',
    family: 'retrievalHeavy',
    query: 'superset/sqllab/query_render.py superset/commands/sql_lab/execute.py superset/sql/parse.py SqlQueryRenderImpl SqlQueryRenderException ExecuteSqlCommand SqlQueryRender render validate',
    difficulty: 'hard',
    goldenFiles: [
      'superset/sqllab/query_render.py',
      'superset/commands/sql_lab/execute.py',
      'superset/sql/parse.py'
    ],
    goldenSymbols: ['SqlQueryRenderImpl', 'SqlQueryRenderException', 'ExecuteSqlCommand', 'SqlQueryRender'],
    goldenRelations: [
      relation('contains', 'superset/sqllab/query_render.py', 'SqlQueryRenderImpl'),
      relation('contains', 'superset/sqllab/query_render.py', 'SqlQueryRenderException'),
      relation('contains', 'superset/commands/sql_lab/execute.py', 'ExecuteSqlCommand'),
      relation('contains', 'superset/sql/parse.py', 'validate')
    ],
    requiredTopK: 8,
    requiredEvidenceTerms: ['sql', 'template', 'undefined', 'parameter', 'render'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'tests/unit_tests/sql_lab_test.py',
      'tests/integration_tests/sql_validator_tests.py'
    ]
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-flow-mcp-stdio',
    family: 'flow',
    query: 'superset/mcp_service/__main__.py superset/mcp_service/app.py superset/mcp_service/server.py superset/mcp_service/middleware.py main _add_default_middlewares build_middleware_list init_fastmcp_server run_server create_response_size_guard_middleware create_mcp_app',
    difficulty: 'medium',
    goldenFiles: [
      'superset/mcp_service/__main__.py',
      'superset/mcp_service/app.py',
      'superset/mcp_service/server.py',
      'superset/mcp_service/middleware.py'
    ],
    goldenSymbols: [
      'main',
      '_add_default_middlewares',
      'build_middleware_list',
      'init_fastmcp_server',
      'run_server',
      'create_response_size_guard_middleware',
      'create_mcp_app'
    ],
    goldenRelations: [
      relation('contains', 'superset/mcp_service/__main__.py', 'main'),
      relation('contains', 'superset/mcp_service/app.py', 'create_mcp_app'),
      relation('contains', 'superset/mcp_service/server.py', 'init_fastmcp_server'),
      relation('contains', 'superset/mcp_service/server.py', 'run_server'),
      relation('contains', 'superset/mcp_service/middleware.py', '_add_default_middlewares'),
      relation('contains', 'superset/mcp_service/middleware.py', 'build_middleware_list')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['stdio', 'middleware', 'fastmcp', 'transport', 'server'],
    goldenTests: [
      'tests/unit_tests/test_mcp_stdio_entrypoint.py',
      'tests/unit_tests/mcp_service/test_mcp_server.py'
    ],
    goldenRuntimeArtifacts: [
      'superset/mcp_service/__main__.py',
      'superset/mcp_service/app.py',
      'superset/mcp_service/server.py',
      'superset/mcp_service/middleware.py'
    ]
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-flow-thumbnail-cache',
    family: 'flow',
    query: 'superset/models/dashboard.py superset/models/slice.py superset/tasks/thumbnails.py superset/thumbnails/digest.py superset/utils/screenshots.py cache_chart_thumbnail cache_dashboard_thumbnail cache_dashboard_screenshot get_dashboard_digest get_chart_digest DashboardScreenshot ChartScreenshot',
    difficulty: 'medium',
    goldenFiles: [
      'superset/models/dashboard.py',
      'superset/models/slice.py',
      'superset/tasks/thumbnails.py',
      'superset/thumbnails/digest.py',
      'superset/utils/screenshots.py'
    ],
    goldenSymbols: [
      'cache_chart_thumbnail',
      'cache_dashboard_thumbnail',
      'cache_dashboard_screenshot',
      'DashboardScreenshot',
      'ChartScreenshot',
      'get_dashboard_digest',
      'get_chart_digest'
    ],
    goldenRelations: [
      relation('contains', 'superset/tasks/thumbnails.py', 'cache_chart_thumbnail'),
      relation('contains', 'superset/tasks/thumbnails.py', 'cache_dashboard_thumbnail'),
      relation('contains', 'superset/tasks/thumbnails.py', 'cache_dashboard_screenshot'),
      relation('contains', 'superset/models/dashboard.py', 'DashboardScreenshot'),
      relation('contains', 'superset/models/slice.py', 'ChartScreenshot')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['thumbnail', 'cache', 'screenshot', 'dashboard', 'chart'],
    goldenTests: ['tests/integration_tests/thumbnails_tests.py'],
    goldenRuntimeArtifacts: [
      'superset/tasks/thumbnails.py',
      'superset/thumbnails/digest.py',
      'superset/utils/screenshots.py'
    ],
    requiredConsequenceTerms: ['thumbnail', 'cache', 'screenshot', 'dashboard', 'chart', 'playwright'],
    impactRequired: true
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-struct-dashboard-graph',
    family: 'structure',
    query: 'superset/models/dashboard.py superset/models/slice.py superset/models/helpers.py superset/utils/dashboard_import_export.py Dashboard copy_dashboard export_dashboards get_url datasources status',
    difficulty: 'medium',
    goldenFiles: [
      'superset/models/dashboard.py',
      'superset/models/slice.py',
      'superset/models/helpers.py',
      'superset/utils/dashboard_import_export.py'
    ],
    goldenSymbols: ['Dashboard', 'copy_dashboard', 'export_dashboards', 'get_url'],
    goldenRelations: [
      relation('contains', 'superset/models/dashboard.py', 'Dashboard'),
      relation('contains', 'superset/models/dashboard.py', 'copy_dashboard'),
      relation('contains', 'superset/utils/dashboard_import_export.py', 'export_dashboards'),
      relation('contains', 'superset/models/helpers.py', 'get_url')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['dashboard', 'export', 'slice', 'owner', 'relationship'],
    goldenTests: [
      'tests/unit_tests/dashboards/schema_tests.py',
      'tests/integration_tests/dashboard_tests.py'
    ]
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-struct-slice-graph',
    family: 'structure',
    query: 'superset/models/slice.py superset/models/core.py superset/connectors/sqla/models.py superset/viz.py Slice clone datasource_name_text viz set_related_perm event_after_chart_changed',
    difficulty: 'medium',
    goldenFiles: [
      'superset/models/slice.py',
      'superset/models/core.py',
      'superset/connectors/sqla/models.py',
      'superset/viz.py'
    ],
    goldenSymbols: ['Slice', 'clone', 'datasource_name_text', 'viz', 'set_related_perm', 'event_after_chart_changed'],
    goldenRelations: [
      relation('contains', 'superset/models/slice.py', 'Slice'),
      relation('contains', 'superset/models/slice.py', 'clone'),
      relation('contains', 'superset/models/slice.py', 'datasource_name_text'),
      relation('contains', 'superset/models/slice.py', 'viz'),
      relation('contains', 'superset/models/slice.py', 'set_related_perm')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['slice', 'datasource', 'viz', 'chart', 'table'],
    goldenTests: [
      'tests/integration_tests/viz_tests.py',
      'tests/unit_tests/test_viz_get_df_payload.py'
    ]
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-impact-sqllab-persist-off',
    family: 'impact',
    query: 'superset/views/sqllab.py superset/sqllab/sql_json_executer.py superset/sqllab/query_render.py superset/commands/sql_lab/execute.py tests/integration_tests/sqllab_tests.py tests/integration_tests/superset_test_config_sqllab_backend_persist_off.py tests/integration_tests/superset_test_config.py SqllabView ExecuteSqlCommand SynchronousSqlJsonExecutor ASynchronousSqlJsonExecutor SqlJsonExecutor SqlQueryRender',
    difficulty: 'hard',
    goldenFiles: [
      'superset/views/sqllab.py',
      'superset/sqllab/sql_json_executer.py',
      'superset/sqllab/query_render.py',
      'superset/commands/sql_lab/execute.py'
    ],
    goldenSymbols: [
      'SqllabView',
      'ExecuteSqlCommand',
      'SynchronousSqlJsonExecutor',
      'ASynchronousSqlJsonExecutor',
      'SqlJsonExecutor',
      'SqlQueryRender'
    ],
    goldenRelations: [
      relation('contains', 'superset/views/sqllab.py', 'SqllabView'),
      relation('contains', 'superset/commands/sql_lab/execute.py', 'ExecuteSqlCommand'),
      relation('contains', 'superset/sqllab/sql_json_executer.py', 'SynchronousSqlJsonExecutor'),
      relation('contains', 'superset/sqllab/sql_json_executer.py', 'ASynchronousSqlJsonExecutor'),
      relation('contains', 'superset/sqllab/sql_json_executer.py', 'SqlJsonExecutor'),
      relation('contains', 'superset/sqllab/query_render.py', 'SqlQueryRender')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['sqllab', 'persist', 'backend', 'results', 'query'],
    goldenTests: ['tests/integration_tests/sqllab_tests.py'],
    goldenRuntimeArtifacts: [
      'tests/integration_tests/superset_test_config_sqllab_backend_persist_off.py',
      'tests/integration_tests/superset_test_config.py'
    ],
    requiredConsequenceTerms: ['persist', 'backend', 'results', 'query', 'limit'],
    impactRequired: true
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-impact-thumbnails-config',
    family: 'impact',
    query: 'superset/tasks/thumbnails.py superset/models/dashboard.py superset/models/slice.py superset/thumbnails/digest.py superset/utils/screenshots.py tests/integration_tests/thumbnails_tests.py tests/integration_tests/superset_test_config_thumbnails.py superset/config.py cache_chart_thumbnail cache_dashboard_thumbnail cache_dashboard_screenshot DashboardScreenshot ChartScreenshot get_dashboard_digest get_chart_digest',
    difficulty: 'hard',
    goldenFiles: [
      'superset/tasks/thumbnails.py',
      'superset/models/dashboard.py',
      'superset/models/slice.py',
      'superset/thumbnails/digest.py',
      'superset/utils/screenshots.py'
    ],
    goldenSymbols: [
      'cache_chart_thumbnail',
      'cache_dashboard_thumbnail',
      'cache_dashboard_screenshot',
      'DashboardScreenshot',
      'ChartScreenshot',
      'get_dashboard_digest',
      'get_chart_digest'
    ],
    goldenRelations: [
      relation('contains', 'superset/tasks/thumbnails.py', 'cache_chart_thumbnail'),
      relation('contains', 'superset/tasks/thumbnails.py', 'cache_dashboard_thumbnail'),
      relation('contains', 'superset/tasks/thumbnails.py', 'cache_dashboard_screenshot'),
      relation('contains', 'superset/models/dashboard.py', 'DashboardScreenshot'),
      relation('contains', 'superset/models/slice.py', 'ChartScreenshot')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['thumbnail', 'cache', 'screenshot', 'dashboard', 'chart'],
    goldenTests: ['tests/integration_tests/thumbnails_tests.py'],
    goldenRuntimeArtifacts: [
      'tests/integration_tests/superset_test_config_thumbnails.py',
      'superset/config.py'
    ],
    requiredConsequenceTerms: ['thumbnail', 'cache', 'screenshot', 'dashboard', 'chart', 'playwright'],
    impactRequired: true
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-fresh-mcp-surface',
    family: 'freshness',
    query: 'superset/mcp_service/__main__.py superset/mcp_service/app.py superset/mcp_service/server.py superset/mcp_service/middleware.py tests/unit_tests/test_mcp_stdio_entrypoint.py tests/unit_tests/mcp_service/test_mcp_server.py tests/unit_tests/mcp_service/test_mcp_tool_registration.py get_default_instructions create_mcp_app init_fastmcp_server build_middleware_list run_server',
    difficulty: 'hard',
    goldenFiles: [
      'superset/mcp_service/__main__.py',
      'superset/mcp_service/app.py',
      'superset/mcp_service/server.py',
      'superset/mcp_service/middleware.py',
      'tests/unit_tests/test_mcp_stdio_entrypoint.py',
      'tests/unit_tests/mcp_service/test_mcp_server.py',
      'tests/unit_tests/mcp_service/test_mcp_tool_registration.py'
    ],
    goldenSymbols: [
      'get_default_instructions',
      'create_mcp_app',
      'init_fastmcp_server',
      'build_middleware_list',
      'run_server'
    ],
    goldenRelations: [
      relation('contains', 'superset/mcp_service/__main__.py', 'get_default_instructions'),
      relation('contains', 'superset/mcp_service/app.py', 'create_mcp_app'),
      relation('contains', 'superset/mcp_service/server.py', 'init_fastmcp_server'),
      relation('contains', 'superset/mcp_service/server.py', 'run_server'),
      relation('contains', 'superset/mcp_service/middleware.py', 'build_middleware_list')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['mcp', 'instructions', 'middleware', 'server', 'stdio'],
    freshnessSetup: {
      newTargets: [
        'superset/mcp_service/app.py',
        'superset/mcp_service/server.py',
        'superset/mcp_service/middleware.py'
      ],
      staleTargets: [
        'superset/views/base.py',
        'superset/views/sqllab.py',
        'superset/security/manager.py'
      ]
    },
    goldenTests: [
      'tests/unit_tests/test_mcp_stdio_entrypoint.py',
      'tests/unit_tests/mcp_service/test_mcp_server.py'
    ]
  }),
  makeCase({
    repoId: 'apache-superset',
    tier: 'core',
    queryId: 'superset-fresh-guest-token-revocation',
    family: 'freshness',
    query: 'superset/security/guest_token.py superset/security/manager.py superset/security/session_invalidation.py superset/views/auth.py tests/integration_tests/security/guest_token_security_tests.py tests/integration_tests/security_tests.py build_guest_token_audit_payload get_current_guest_token_revocation_version bump_guest_token_revocation_version revoke_guest_token_access get_guest_user_from_token',
    difficulty: 'hard',
    goldenFiles: [
      'superset/security/guest_token.py',
      'superset/security/manager.py',
      'superset/security/session_invalidation.py',
      'superset/views/auth.py',
      'tests/integration_tests/security/guest_token_security_tests.py',
      'tests/integration_tests/security_tests.py'
    ],
    goldenSymbols: [
      'build_guest_token_audit_payload',
      'get_current_guest_token_revocation_version',
      'bump_guest_token_revocation_version',
      'revoke_guest_token_access',
      'get_guest_user_from_token',
      'GuestUser',
      'SupersetSecurityManager'
    ],
    goldenRelations: [
      relation('contains', 'superset/security/guest_token.py', 'build_guest_token_audit_payload'),
      relation('contains', 'superset/security/guest_token.py', 'get_current_guest_token_revocation_version'),
      relation('contains', 'superset/security/guest_token.py', 'bump_guest_token_revocation_version'),
      relation('contains', 'superset/security/guest_token.py', 'revoke_guest_token_access'),
      relation('contains', 'superset/security/guest_token.py', 'get_guest_user_from_token'),
      relation('contains', 'superset/security/manager.py', 'SupersetSecurityManager')
    ],
    requiredTopK: 5,
    requiredEvidenceTerms: ['guest', 'token', 'revocation', 'session', 'auth'],
    freshnessSetup: {
      newTargets: [
        'superset/security/guest_token.py',
        'superset/security/manager.py'
      ],
      staleTargets: [
        'superset/security/session_invalidation.py',
        'superset/views/auth.py',
        'superset/security/password_change.py'
      ]
    },
    goldenTests: [
      'tests/integration_tests/security/guest_token_security_tests.py',
      'tests/integration_tests/security_tests.py'
    ]
  })
];
