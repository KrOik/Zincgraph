import { makeCase, relation } from './_shared.mjs';

export default [
  makeCase({
    repoId: 'airbyte',
    tier: 'stress',
    queryId: 'airbyte-rh-couchbase-source-tests',
    family: 'retrievalHeavy',
    query: 'SourceCouchbase test_streams test_check_connection test_get_cluster test_set_config_values',
    difficulty: 'hard',
    goldenFiles: [
      'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py',
      'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py'
    ],
    goldenSymbols: [
      'SourceCouchbase::name',
      'SourceCouchbase::_set_config_values',
      'SourceCouchbase::streams',
      'SourceCouchbase::check_connection',
      'test_streams',
      'test_check_connection',
      'test_get_cluster',
      'test_set_config_values',
      'test_ensure_primary_index'
    ],
    goldenRelations: [
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::name'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::_set_config_values'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::streams'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::check_connection'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_streams'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_check_connection'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_get_cluster'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_set_config_values'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_ensure_primary_index')
    ],
    requiredTopK: 12,
    requiredEvidenceTerms: ['couchbase', 'cluster', 'bucket', 'stream', 'query'],
    goldenTests: ['airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py'],
    goldenRuntimeArtifacts: ['airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py']
  }),
  makeCase({
    repoId: 'airbyte',
    tier: 'stress',
    queryId: 'airbyte-connector-couchbase-source-runtime',
    family: 'connector-discovery',
    query: 'SourceCouchbase test_streams test_check_connection test_get_cluster',
    difficulty: 'medium',
    goldenFiles: [
      'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py',
      'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py'
    ],
    goldenSymbols: [
      'SourceCouchbase::_get_cluster',
      'SourceCouchbase::streams',
      'SourceCouchbase::check_connection',
      'test_streams',
      'test_check_connection',
      'test_get_cluster'
    ],
    goldenRelations: [
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::_get_cluster'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::streams'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py', 'SourceCouchbase::check_connection'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_streams'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_check_connection'),
      relation('contains', 'airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py', 'test_get_cluster')
    ],
    goldenImplementations: ['SourceCouchbase::streams'],
    requiredTopK: 12,
    requiredEvidenceTerms: ['bucket', 'stream', 'index', 'cursor', 'query'],
    goldenTests: ['airbyte-integrations/connectors/source-couchbase/unit_tests/test_unit_source.py'],
    goldenRuntimeArtifacts: ['airbyte-integrations/connectors/source-couchbase/source_couchbase/source.py']
  }),
  makeCase({
    repoId: 'airbyte',
    tier: 'stress',
    queryId: 'airbyte-connector-destination-sqlite',
    family: 'connector-discovery',
    query: 'DestinationSqlite _get_destination_path write check test_get_destination_path',
    difficulty: 'medium',
    goldenFiles: [
      'airbyte-integrations/connectors/destination-sqlite/destination_sqlite/destination.py',
      'airbyte-integrations/connectors/destination-sqlite/integration_tests/integration_test.py'
    ],
    goldenSymbols: [
      'DestinationSqlite::_get_destination_path',
      'DestinationSqlite::check',
      'test_write'
    ],
    goldenRelations: [
      relation('contains', 'airbyte-integrations/connectors/destination-sqlite/destination_sqlite/destination.py', 'DestinationSqlite::_get_destination_path'),
      relation('contains', 'airbyte-integrations/connectors/destination-sqlite/destination_sqlite/destination.py', 'DestinationSqlite::check'),
      relation('contains', 'airbyte-integrations/connectors/destination-sqlite/integration_tests/integration_test.py', 'test_write'),
    ],
    goldenImplementations: ['DestinationSqlite::_get_destination_path'],
    requiredTopK: 12,
    requiredEvidenceTerms: ['sqlite', 'destination', 'table', 'path', 'record'],
    goldenTests: ['airbyte-integrations/connectors/destination-sqlite/integration_tests/integration_test.py'],
    goldenRuntimeArtifacts: ['airbyte-integrations/connectors/destination-sqlite/destination_sqlite/destination.py']
  }),
  makeCase({
    repoId: 'airbyte',
    tier: 'stress',
    queryId: 'airbyte-config-runtime-firebase',
    family: 'config-to-runtime',
    query: 'SourceFirebaseRealtimeDatabase stream_name_from test_stream_name_from test_records',
    difficulty: 'hard',
    goldenFiles: [
      'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py',
      'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py'
    ],
    goldenSymbols: [
      'SourceFirebaseRealtimeDatabase',
      'SourceFirebaseRealtimeDatabase::check',
      'SourceFirebaseRealtimeDatabase::read',
      'PseudoClient',
      'PseudoClient::__init__',
      'PseudoClient::fetch_records',
      'test_stream_name_from',
      'test_records'
    ],
    goldenRelations: [
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py', 'SourceFirebaseRealtimeDatabase'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py', 'SourceFirebaseRealtimeDatabase::check'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py', 'SourceFirebaseRealtimeDatabase::read'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py', 'PseudoClient'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py', 'PseudoClient::__init__'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py', 'PseudoClient::fetch_records'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py', 'test_stream_name_from'),
      relation('contains', 'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py', 'test_records')
    ],
    requiredTopK: 12,
    requiredEvidenceTerms: ['database', 'buffer_size', 'credentials', 'record', 'path'],
    goldenTests: [
      'airbyte-integrations/connectors/source-firebase-realtime-database/unit_tests/unit_test.py'
    ],
    goldenRuntimeArtifacts: [
      'airbyte-integrations/connectors/source-firebase-realtime-database/source_firebase_realtime_database/source.py'
    ],
    impactRequired: true,
    freshnessSetup: { newTargets: [], staleTargets: [] }
  }),
  makeCase({
    repoId: 'airbyte',
    tier: 'stress',
    queryId: 'airbyte-freshness-twilio-manifest',
    family: 'freshness',
    query: 'TwilioStateMigration TwilioAlertsStateMigration TwilioUsageRecordsStateMigration test_streams test_next_page_token test_transform_function',
    difficulty: 'medium',
    goldenFiles: [
      'airbyte-integrations/connectors/source-twilio/components.py',
      'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py'
    ],
    goldenSymbols: [
      'TwilioUsageRecordsStateMigration',
      'TwilioUsageRecordsStateMigration::migrate',
      'TwilioUsageRecordsStateMigration::should_migrate',
      'TestTwilioStream',
      'TestIncrementalTwilioStream'
    ],
    goldenRelations: [
      relation('contains', 'airbyte-integrations/connectors/source-twilio/components.py', 'TwilioUsageRecordsStateMigration'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/components.py', 'TwilioUsageRecordsStateMigration::migrate'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/components.py', 'TwilioUsageRecordsStateMigration::should_migrate'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py', 'TestTwilioStream'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py', 'TestIncrementalTwilioStream')
    ],
    requiredTopK: 12,
    requiredEvidenceTerms: ['manifest', 'schema', 'state', 'migration', 'record'],
    goldenTests: [
      'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py'
    ],
    goldenRuntimeArtifacts: [
      'airbyte-integrations/connectors/source-twilio/components.py'
    ],
    freshnessSetup: {
      newTargets: ['airbyte-integrations/connectors/source-twilio/components.py'],
      staleTargets: ['airbyte-integrations/connectors/source-twilio/manifest.yaml']
    }
  }),
  makeCase({
    repoId: 'airbyte',
    tier: 'stress',
    queryId: 'airbyte-impact-twilio-state-migrations',
    family: 'affected-tests',
    query: 'TwilioUsageRecordsStateMigration usage_records test_usage_records_404_handling test_streams TwilioStateMigration',
    difficulty: 'hard',
    goldenFiles: [
      'airbyte-integrations/connectors/source-twilio/components.py',
      'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py',
      'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py'
    ],
    goldenSymbols: [
      'TwilioUsageRecordsStateMigration',
      'TwilioUsageRecordsStateMigration::migrate',
      'TwilioUsageRecordsStateMigration::should_migrate',
      'TestIncrementalTwilioStream',
      'TestUsageRecords404Handling',
      'TestUsageRecords404Handling::test_usage_records_ignores_404_responses',
      'TestUsageRecords404Handling::test_usage_records_incremental_with_404_handling'
    ],
    goldenRelations: [
      relation('contains', 'airbyte-integrations/connectors/source-twilio/components.py', 'TwilioUsageRecordsStateMigration'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/components.py', 'TwilioUsageRecordsStateMigration::migrate'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/components.py', 'TwilioUsageRecordsStateMigration::should_migrate'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py', 'TestIncrementalTwilioStream'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py', 'TestUsageRecords404Handling'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py', 'TestUsageRecords404Handling::test_usage_records_ignores_404_responses'),
      relation('contains', 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py', 'TestUsageRecords404Handling::test_usage_records_incremental_with_404_handling')
    ],
    requiredTopK: 25,
    requiredEvidenceTerms: ['404', 'skipping', 'state', 'parent_slice', 'lookback_window'],
    goldenTests: [
      'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py',
      'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py'
    ],
    goldenRuntimeArtifacts: [
      'airbyte-integrations/connectors/source-twilio/components.py'
    ],
    requiredConsequenceTerms: ['404', 'skipping', 'state', 'parent_slice', 'lookback_window'],
    impactRequired: true,
    freshnessSetup: { newTargets: [], staleTargets: [] }
  })
];
