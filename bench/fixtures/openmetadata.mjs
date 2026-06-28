import { makeCase, relation } from './_shared.mjs';

export default [
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-rh-entity-subtree',
    family: 'retrievalHeavy',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java bulkRestoreSubtree bulkSoftDeleteSubtree bulkHardDeleteSubtree deleteChildren cleanup loadForBulk',
    difficulty: 'hard',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/jdbi3/EntityRepositoryRestoreTest.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.jdbi3::EntityRepository::bulkRestoreSubtree',
      'org.openmetadata.service.jdbi3::EntityRepository::bulkSoftDeleteSubtree',
      'org.openmetadata.service.jdbi3::EntityRepository::bulkHardDeleteSubtree',
      'org.openmetadata.service.jdbi3::EntityRepository::deleteChildren',
      'org.openmetadata.service.jdbi3::EntityRepository::cleanup'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'bulkRestoreSubtree'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'bulkSoftDeleteSubtree'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'bulkHardDeleteSubtree'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'deleteChildren'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'cleanup')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['bulk', 'subtree', 'restore', 'delete', 'cleanup'],
    freshnessSetup: {
      newTargets: ['openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java'],
      staleTargets: ['openmetadata-mcp/src/main/java/org/openmetadata/mcp/tools/SearchMetadataTool.java']
    },
    goldenTests: ['openmetadata-service/src/test/java/org/openmetadata/service/jdbi3/EntityRepositoryRestoreTest.java'],
    goldenRuntimeArtifacts: [
      'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/ServiceEntityRepository.java'
    ]
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-rh-search-rewrite',
    family: 'retrievalHeavy',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java updateEntitiesByReference updateEntitiesIndex deleteEntityByFQNPrefix softDeleteOrRestoreEntityIndex deleteOrUpdateChildren searchLineage',
    difficulty: 'hard',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/search/SearchRepositoryTest.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.search::SearchRepository::updateEntitiesByReference',
      'org.openmetadata.service.search::SearchRepository::updateEntitiesIndex',
      'org.openmetadata.service.search::SearchRepository::deleteEntityByFQNPrefix',
      'org.openmetadata.service.search::SearchRepository::softDeleteOrRestoreEntityIndex',
      'org.openmetadata.service.search::SearchRepository::deleteOrUpdateChildren',
      'org.openmetadata.service.search::SearchRepository::searchLineage'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'updateEntitiesByReference'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'updateEntitiesIndex'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'deleteEntityByFQNPrefix'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'softDeleteOrRestoreEntityIndex'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'deleteOrUpdateChildren'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'searchLineage')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['search', 'lineage', 'fqn', 'prefix', 'index'],
    freshnessSetup: {
      newTargets: ['openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java'],
      staleTargets: ['openmetadata-mcp/src/main/java/org/openmetadata/mcp/tools/GetEntityTool.java']
    },
    goldenTests: ['openmetadata-service/src/test/java/org/openmetadata/service/search/SearchRepositoryTest.java'],
    goldenRuntimeArtifacts: ['openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java']
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-flow-session-activation',
    family: 'flow',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java createActiveSession createPendingSession applySessionLimit completeRefresh releaseRefreshLease revokeSession recordSessionAccess getSessionById registerRevocationListener',
    difficulty: 'hard',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/security/session/SessionServiceTest.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.security.session::SessionService::registerRevocationListener',
      'org.openmetadata.service.security.session::SessionService::createActiveSession',
      'org.openmetadata.service.security.session::SessionService::createPendingSession',
      'org.openmetadata.service.security.session::SessionService::completeRefresh',
      'org.openmetadata.service.security.session::SessionService::releaseRefreshLease',
      'org.openmetadata.service.security.session::SessionService::revokeSession',
      'org.openmetadata.service.security.session::SessionService::getSessionById',
      'org.openmetadata.service.security.session::SessionService::recordSessionAccess',
      'org.openmetadata.service.security.session::SessionService::applySessionLimit'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'registerRevocationListener'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'createActiveSession'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'createPendingSession'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'completeRefresh'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'releaseRefreshLease'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'revokeSession'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'recordSessionAccess'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'applySessionLimit')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['session', 'refresh', 'lease', 'revocation', 'access'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: ['openmetadata-service/src/test/java/org/openmetadata/service/security/session/SessionServiceTest.java'],
    goldenRuntimeArtifacts: ['openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java']
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-flow-jwt-filter',
    family: 'flow',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java filter checkValidationsForToken getSessionService setSessionService',
    difficulty: 'medium',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.security::JwtFilter::filter',
      'org.openmetadata.service.security::JwtFilter::checkValidationsForToken',
      'org.openmetadata.service.security::AuthServeletHandlerRegistry::getSessionService',
      'org.openmetadata.service.security::AuthServeletHandlerRegistry::setSessionService'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java', 'filter'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java', 'checkValidationsForToken'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java', 'getSessionService'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java', 'setSessionService')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['jwt', 'token', 'session', 'filter', 'registry'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: ['openmetadata-service/src/test/java/org/openmetadata/service/security/JwtFilterTest.java'],
    goldenRuntimeArtifacts: [
      'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java'
    ]
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-struct-delete-hooks',
    family: 'structure',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java bulkRestoreSubtree bulkSoftDeleteSubtree bulkHardDeleteSubtree loadForBulk deleteChildren cleanup',
    difficulty: 'medium',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/jdbi3/EntityRepositoryRestoreTest.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.jdbi3::EntityRepository::bulkRestoreSubtree',
      'org.openmetadata.service.jdbi3::EntityRepository::bulkSoftDeleteSubtree',
      'org.openmetadata.service.jdbi3::EntityRepository::bulkHardDeleteSubtree',
      'org.openmetadata.service.jdbi3::EntityRepository::loadForBulk'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'bulkRestoreSubtree'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'bulkSoftDeleteSubtree'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'bulkHardDeleteSubtree'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java', 'loadForBulk')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['restore', 'delete', 'children', 'bulk', 'load'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: ['openmetadata-service/src/test/java/org/openmetadata/service/jdbi3/EntityRepositoryRestoreTest.java'],
    goldenRuntimeArtifacts: ['openmetadata-service/src/main/java/org/openmetadata/service/jdbi3/EntityRepository.java']
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-struct-search-plumbing',
    family: 'structure',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java deleteEntityByFQNPrefix softDeleteOrRestoreEntityIndex deleteOrUpdateChildren searchLineage updateEntitiesByReference',
    difficulty: 'medium',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/search/SearchRepositoryTest.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.search::SearchRepository::deleteOrUpdateChildren',
      'org.openmetadata.service.search::SearchRepository::softDeleteOrRestoreEntityIndex',
      'org.openmetadata.service.search::SearchRepository::deleteEntityByFQNPrefix',
      'org.openmetadata.service.search::SearchRepository::searchLineage',
      'org.openmetadata.service.search::SearchRepository::updateEntitiesByReference'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'deleteEntityByFQNPrefix'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'softDeleteOrRestoreEntityIndex'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'deleteOrUpdateChildren'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'searchLineage'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java', 'updateEntitiesByReference')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['search', 'lineage', 'fqn', 'prefix', 'children'],
    freshnessSetup: { newTargets: [], staleTargets: [] },
    goldenTests: ['openmetadata-service/src/test/java/org/openmetadata/service/search/SearchRepositoryTest.java'],
    goldenRuntimeArtifacts: ['openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java']
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-impact-jwt-session',
    family: 'impact',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java filter checkValidationsForToken revokeSession registerRevocationListener getSessionService',
    difficulty: 'hard',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.security::JwtFilter::filter',
      'org.openmetadata.service.security::JwtFilter::checkValidationsForToken',
      'org.openmetadata.service.security.session::SessionService::revokeSession',
      'org.openmetadata.service.security.session::SessionService::registerRevocationListener',
      'org.openmetadata.service.security::AuthServeletHandlerRegistry::getSessionService'
    ],
    goldenRelations: [
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java', 'filter'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java', 'checkValidationsForToken'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'revokeSession'),
      relation('contains', 'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java', 'registerRevocationListener')
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['jwt', 'session', 'token', 'refresh', 'revocation'],
    goldenTests: [
      'openmetadata-service/src/test/java/org/openmetadata/service/security/JwtFilterTest.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/security/session/SessionServiceTest.java'
    ],
    goldenRuntimeArtifacts: [
      'openmetadata-service/src/main/java/org/openmetadata/service/security/JwtFilter.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/AuthServeletHandlerRegistry.java'
    ],
    requiredConsequenceTerms: ['jwt', 'session', 'token', 'refresh', 'revocation'],
    impactRequired: true,
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'openmetadata',
    tier: 'extended',
    queryId: 'om-fresh-search-session',
    family: 'freshness',
    query: 'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java searchLineage createActiveSession revokeSession deleteOrUpdateChildren',
    difficulty: 'medium',
    goldenFiles: [
      'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/search/SearchRepositoryTest.java'
    ],
    goldenSymbols: [
      'org.openmetadata.service.search::SearchRepository::searchLineage',
      'org.openmetadata.service.search::SearchRepository::deleteOrUpdateChildren',
      'org.openmetadata.service.security.session::SessionService::createActiveSession',
      'org.openmetadata.service.security.session::SessionService::revokeSession'
    ],
    requiredTopK: 6,
    requiredEvidenceTerms: ['search', 'session', 'lineage', 'refresh'],
    freshnessSetup: {
      newTargets: [
        'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java',
        'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java'
      ],
      staleTargets: ['openmetadata-mcp/src/main/java/org/openmetadata/mcp/tools/SearchMetadataTool.java']
    },
    goldenTests: [
      'openmetadata-service/src/test/java/org/openmetadata/service/search/SearchRepositoryTest.java',
      'openmetadata-service/src/test/java/org/openmetadata/service/security/session/SessionServiceTest.java'
    ],
    goldenRuntimeArtifacts: [
      'openmetadata-service/src/main/java/org/openmetadata/service/search/SearchRepository.java',
      'openmetadata-service/src/main/java/org/openmetadata/service/security/session/SessionService.java'
    ]
  })
];
