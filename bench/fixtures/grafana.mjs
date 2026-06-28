import { makeCase, relation } from './_shared.mjs';

export default [
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-rh-migration-cache',
    family: 'retrievalHeavy',
    query: 'apps/dashboard/pkg/migration/migrate.go apps/dashboard/pkg/migration/schemaversion/cache.go Initialize PreloadCache PreloadCacheInBackground ResetForTesting cachedProvider::Preload cachedProvider::Get',
    difficulty: 'hard',
    goldenFiles: [
      'apps/dashboard/pkg/migration/migrate.go',
      'apps/dashboard/pkg/migration/schemaversion/cache.go'
    ],
    goldenSymbols: ['Initialize', 'PreloadCache', 'PreloadCacheInBackground', 'ResetForTesting', 'cachedProvider::Preload'],
    goldenRelations: [
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'Initialize'),
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'PreloadCache'),
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'PreloadCacheInBackground'),
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'ResetForTesting'),
      relation('contains', 'apps/dashboard/pkg/migration/schemaversion/cache.go', 'cachedProvider::Preload')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['cache', 'preload', 'migrator', 'namespace', 'ttl'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'apps/dashboard/pkg/migration/migrate_test.go',
      'apps/dashboard/pkg/migration/schemaversion/cache_test.go'
    ],
    goldenRuntimeArtifacts: [
      'apps/dashboard/pkg/migration/migrate.go',
      'apps/dashboard/pkg/migration/schemaversion/cache.go'
    ]
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-rh-setting-load',
    family: 'retrievalHeavy',
    query: 'pkg/setting/setting.go NewCfg NewCfgFromArgs Load parseINIFile readProvisioningSettings ResolveGrafanaComProxyAPIToken',
    difficulty: 'hard',
    goldenFiles: ['pkg/setting/setting.go'],
    goldenSymbols: [
      'NewCfg',
      'NewCfgFromArgs',
      'Load',
      'parseINIFile',
      'readProvisioningSettings',
      'ResolveGrafanaComProxyAPIToken'
    ],
    goldenRelations: [
      relation('contains', 'pkg/setting/setting.go', 'NewCfg'),
      relation('contains', 'pkg/setting/setting.go', 'NewCfgFromArgs'),
      relation('contains', 'pkg/setting/setting.go', 'Load'),
      relation('contains', 'pkg/setting/setting.go', 'parseINIFile'),
      relation('contains', 'pkg/setting/setting.go', 'readProvisioningSettings'),
      relation('contains', 'pkg/setting/setting.go', 'ResolveGrafanaComProxyAPIToken')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['ini', 'provisioning', 'proxy', 'token', 'settings'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'pkg/setting/setting_test.go',
      'pkg/tests/testinfra/testinfra.go'
    ],
    goldenRuntimeArtifacts: [
      'pkg/setting/setting.go',
      'pkg/tests/testinfra/testinfra.go'
    ]
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-flow-recent-queries',
    family: 'flow',
    query: 'public/app/features/explore/RecentQueries/useRecentQueriesData.ts public/app/features/explore/RecentQueries/filterDefaults.ts useRecentQueriesData defaultSortingOption getStoredFilterDefaults storeFilterDefaults',
    difficulty: 'medium',
    goldenFiles: [
      'public/app/features/explore/RecentQueries/useRecentQueriesData.ts',
      'public/app/features/explore/RecentQueries/filterDefaults.ts'
    ],
    goldenSymbols: [
      'useRecentQueriesData',
      'defaultSortingOption',
      'getStoredFilterDefaults',
      'storeFilterDefaults'
    ],
    goldenRelations: [
      relation('contains', 'public/app/features/explore/RecentQueries/useRecentQueriesData.ts', 'useRecentQueriesData'),
      relation('contains', 'public/app/features/explore/RecentQueries/useRecentQueriesData.ts', 'defaultSortingOption'),
      relation('contains', 'public/app/features/explore/RecentQueries/filterDefaults.ts', 'getStoredFilterDefaults'),
      relation('contains', 'public/app/features/explore/RecentQueries/filterDefaults.ts', 'storeFilterDefaults')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['recent', 'queries', 'starred', 'filters', 'sorting'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'public/app/features/explore/RecentQueries/useRecentQueriesData.test.ts',
      'public/app/features/explore/RecentQueries/filterDefaults.test.ts'
    ],
    goldenRuntimeArtifacts: [
      'public/app/features/explore/RecentQueries/useRecentQueriesData.ts',
      'public/app/features/explore/RecentQueries/filterDefaults.ts'
    ]
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-flow-trace-view',
    family: 'flow',
    query: 'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.tsx public/app/features/explore/TraceView/components/TraceTimelineViewer/TimelineHeaderRow/TimelineHeaderRow.tsx public/app/features/explore/TraceView/components/TraceTimelineViewer/VirtualizedTraceView.tsx public/app/features/explore/TraceView/components/TraceTimelineViewer/SpanDetail/index.tsx UnthemedTraceTimelineViewer TimelineHeaderRow VirtualizedTraceView SpanDetailRow getStyles NUM_TICKS',
    difficulty: 'medium',
    goldenFiles: [
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.tsx',
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/TimelineHeaderRow/TimelineHeaderRow.tsx',
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/VirtualizedTraceView.tsx',
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/SpanDetail/index.tsx'
    ],
    goldenSymbols: [
      'UnthemedTraceTimelineViewer',
      'TimelineHeaderRow',
      'VirtualizedTraceView',
      'SpanDetailRow',
      'getStyles',
      'NUM_TICKS'
    ],
    goldenRelations: [
      relation('contains', 'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.tsx', 'UnthemedTraceTimelineViewer'),
      relation('contains', 'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.tsx', 'TimelineHeaderRow'),
      relation('contains', 'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.tsx', 'VirtualizedTraceView'),
      relation('contains', 'public/app/features/explore/TraceView/components/TraceTimelineViewer/SpanDetail/index.tsx', 'getStyles')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['trace', 'timeline', 'span', 'header', 'collapse'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.test.tsx',
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/VirtualizedTraceView.test.tsx'
    ],
    goldenRuntimeArtifacts: [
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/index.tsx',
      'public/app/features/explore/TraceView/components/TraceTimelineViewer/TimelineHeaderRow/TimelineHeaderRow.tsx'
    ]
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-struct-nav-sort',
    family: 'structure',
    query: 'pkg/services/navtree/models.go pkg/services/anonymous/sortopts/sortopts.go packages/grafana-data/src/utils/Registry.ts NavTreeRoot Sort RemoveEmptyAdminSections RemoveEmptyConnectionsSection ParseSortQueryParam Registry',
    difficulty: 'medium',
    goldenFiles: [
      'pkg/services/navtree/models.go',
      'pkg/services/anonymous/sortopts/sortopts.go',
      'packages/grafana-data/src/utils/Registry.ts'
    ],
    goldenSymbols: [
      'NavTreeRoot',
      'Sort',
      'RemoveEmptyAdminSections',
      'RemoveEmptyConnectionsSection',
      'ParseSortQueryParam',
      'Registry'
    ],
    goldenRelations: [
      relation('contains', 'pkg/services/navtree/models.go', 'NavTreeRoot'),
      relation('contains', 'pkg/services/navtree/models.go', 'Sort'),
      relation('contains', 'pkg/services/navtree/models.go', 'RemoveEmptyAdminSections'),
      relation('contains', 'pkg/services/navtree/models.go', 'RemoveEmptyConnectionsSection'),
      relation('contains', 'pkg/services/anonymous/sortopts/sortopts.go', 'ParseSortQueryParam'),
      relation('contains', 'packages/grafana-data/src/utils/Registry.ts', 'Registry')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['sort', 'nav', 'registry', 'annotation', 'order'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'pkg/services/annotations/models.go',
      'pkg/services/anonymous/sortopts/sortopts.go',
      'pkg/services/navtree/models.go'
    ],
    goldenRuntimeArtifacts: [
      'pkg/services/navtree/models.go',
      'pkg/services/anonymous/sortopts/sortopts.go',
      'packages/grafana-data/src/utils/Registry.ts'
    ]
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-struct-proxy-settings',
    family: 'structure',
    query: 'pkg/api/pluginproxy/settings.go pkg/registry/apis/datasource/sub_proxy_loader.go NewDataSourceProxySettings datasourceLoader DecryptedValues DecryptedPassword DecryptedBasicAuthPassword GetHTTPTransport ProvideDecrypter',
    difficulty: 'medium',
    goldenFiles: [
      'pkg/api/pluginproxy/settings.go',
      'pkg/registry/apis/datasource/sub_proxy_loader.go'
    ],
    goldenSymbols: [
      'NewDataSourceProxySettings',
      'datasourceLoader',
      'DecryptedValues',
      'DecryptedPassword',
      'DecryptedBasicAuthPassword',
      'GetHTTPTransport'
    ],
    goldenRelations: [
      relation('contains', 'pkg/api/pluginproxy/settings.go', 'NewDataSourceProxySettings'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'datasourceLoader'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'DecryptedValues'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'DecryptedPassword'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'DecryptedBasicAuthPassword'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'GetHTTPTransport')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['proxy', 'decrypted', 'transport', 'datasource', 'password'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: [
      'pkg/services/pluginsintegration/pluginsettings/decrypted_test.go',
      'pkg/services/pluginsintegration/pluginsettings/service/service_test.go'
    ],
    goldenRuntimeArtifacts: [
      'pkg/api/pluginproxy/settings.go',
      'pkg/registry/apis/datasource/sub_proxy_loader.go'
    ]
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-impact-datasource-proxy',
    family: 'impact',
    query: 'pkg/api/pluginproxy/settings.go packages/grafana-ui/src/components/DataSourceSettings/SecureSocksProxySettings.tsx pkg/registry/apis/datasource/sub_proxy_loader.go SecureSocksProxySettings datasourceLoader GetHTTPTransport NewDataSourceProxySettings tests/service/service_test.go',
    difficulty: 'hard',
    goldenFiles: [
      'pkg/api/pluginproxy/settings.go',
      'packages/grafana-ui/src/components/DataSourceSettings/SecureSocksProxySettings.tsx',
      'pkg/registry/apis/datasource/sub_proxy_loader.go'
    ],
    goldenSymbols: [
      'SecureSocksProxySettings',
      'datasourceLoader',
      'GetHTTPTransport',
      'NewDataSourceProxySettings'
    ],
    goldenRelations: [
      relation('contains', 'packages/grafana-ui/src/components/DataSourceSettings/SecureSocksProxySettings.tsx', 'SecureSocksProxySettings'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'datasourceLoader'),
      relation('contains', 'pkg/registry/apis/datasource/sub_proxy_loader.go', 'GetHTTPTransport'),
      relation('contains', 'pkg/api/pluginproxy/settings.go', 'NewDataSourceProxySettings')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['proxy', 'secure', 'socks', 'datasource', 'transport'],
    goldenTests: ['pkg/services/pluginsintegration/pluginsettings/service/service_test.go'],
    goldenRuntimeArtifacts: [
      'pkg/api/pluginproxy/settings.go',
      'packages/grafana-ui/src/components/DataSourceSettings/SecureSocksProxySettings.tsx',
      'pkg/registry/apis/datasource/sub_proxy_loader.go'
    ],
    requiredConsequenceTerms: ['proxy', 'secure', 'socks', 'datasource', 'transport'],
    impactRequired: true,
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'grafana',
    tier: 'extended',
    queryId: 'grafana-fresh-migration-cache',
    family: 'freshness',
    query: 'apps/dashboard/pkg/migration/migrate.go apps/dashboard/pkg/migration/schemaversion/cache.go Initialize PreloadCache PreloadCacheInBackground ResetForTesting cachedProvider::Preload apps/dashboard/pkg/migration/migrate_test.go',
    difficulty: 'medium',
    goldenFiles: [
      'apps/dashboard/pkg/migration/migrate.go',
      'apps/dashboard/pkg/migration/schemaversion/cache.go',
      'apps/dashboard/pkg/migration/migrate_test.go'
    ],
    goldenSymbols: [
      'Initialize',
      'PreloadCache',
      'PreloadCacheInBackground',
      'cachedProvider::Preload'
    ],
    goldenRelations: [
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'Initialize'),
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'PreloadCache'),
      relation('contains', 'apps/dashboard/pkg/migration/migrate.go', 'PreloadCacheInBackground'),
      relation('contains', 'apps/dashboard/pkg/migration/schemaversion/cache.go', 'cachedProvider::Preload')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['cache', 'preload', 'migrator', 'namespace'],
    forbiddenFalsePositives: [],
    freshnessSetup: {
      newTargets: ['apps/dashboard/pkg/migration/migrate.go', 'apps/dashboard/pkg/migration/schemaversion/cache.go'],
      staleTargets: ['packages/grafana-data/src/utils/Registry.ts']
    },
    goldenTests: [
      'apps/dashboard/pkg/migration/migrate_test.go',
      'apps/dashboard/pkg/migration/schemaversion/cache_test.go'
    ],
    goldenRuntimeArtifacts: [
      'apps/dashboard/pkg/migration/migrate.go',
      'apps/dashboard/pkg/migration/schemaversion/cache.go'
    ]
  })
];
