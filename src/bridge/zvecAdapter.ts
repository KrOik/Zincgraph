import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type ZvecScenario = 'A:npm-binding' | 'B:napi-wrapper-required';

export interface ZvecNativeWrapperAssessment {
  cApiHeader: string;
  available: boolean;
  requiredExports: string[];
  estimatedEffort: '1-2 weeks' | '2+ weeks';
  risks: string[];
  fallback: string;
}

export interface ZvecProbeResult {
  scenario: ZvecScenario;
  packageAvailable: boolean;
  exports: string[];
  initialized: boolean;
  collectionCreated: boolean;
  inserted: boolean;
  queried: boolean;
  ftsQueried: boolean;
  errors: string[];
  wrapperAssessment?: ZvecNativeWrapperAssessment;
}

type UnknownRecord = Record<string, unknown>;

function functionAt(moduleValue: UnknownRecord, names: string[]): ((...args: unknown[]) => unknown) | undefined {
  for (const name of names) {
    const value = moduleValue[name];
    if (typeof value === 'function') {
      return (...args: unknown[]) => Reflect.apply(value, moduleValue, args);
    }
  }
  return undefined;
}

async function loadZvec(): Promise<UnknownRecord> {
  return (await import('@zvec/zvec')) as unknown as UnknownRecord;
}

export async function isZvecPackageLoadable(): Promise<boolean> {
  try {
    await loadZvec();
    return true;
  } catch {
    return false;
  }
}

export function assessZvecNativeWrapper(): ZvecNativeWrapperAssessment {
  const cApiHeader = resolve('refer/zvec/src/include/zvec/c_api.h');
  return {
    cApiHeader,
    available: existsSync(cApiHeader),
    requiredExports: [
      'zvec_initialize',
      'zvec_collection_create/open',
      'zvec_collection_insert',
      'zvec_collection_query',
      'zvec_query_params_fts_create'
    ],
    estimatedEffort: '2+ weeks',
    risks: [
      'Native build and packaging for Linux/macOS/Windows architectures',
      'Schema/query memory ownership across C API and N-API',
      'Keeping TypeScript bindings in sync with the C++ engine'
    ],
    fallback: 'SQLite FTS5 plus a local cosine-similarity vector table for early development'
  };
}

export async function probeZvec(options: { runOperations?: boolean } = {}): Promise<ZvecProbeResult> {
  const result: ZvecProbeResult = {
    scenario: 'B:napi-wrapper-required',
    packageAvailable: false,
    exports: [],
    initialized: false,
    collectionCreated: false,
    inserted: false,
    queried: false,
    ftsQueried: false,
    errors: []
  };

  let moduleValue: UnknownRecord;
  try {
    moduleValue = await loadZvec();
    result.packageAvailable = true;
    result.exports = Object.keys(moduleValue).sort();
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.wrapperAssessment = assessZvecNativeWrapper();
    return result;
  }

  const init = functionAt(moduleValue, ['ZVecInitialize', 'init', 'initialize', 'zvec_initialize']);
  if (!init) {
    result.errors.push('No init/initialize export was found on @zvec/zvec.');
    result.wrapperAssessment = assessZvecNativeWrapper();
    return result;
  }

  try {
    await init({ log_level: 'error' });
    result.initialized = true;
  } catch {
    try {
      await init();
      result.initialized = true;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!options.runOperations) {
    result.scenario = result.initialized ? 'A:npm-binding' : 'B:napi-wrapper-required';
    if (!result.initialized) {
      result.wrapperAssessment = assessZvecNativeWrapper();
    }
    return result;
  }

  const createAndOpen = functionAt(moduleValue, [
    'ZVecCreateAndOpen',
    'create_and_open',
    'createAndOpen',
    'open'
  ]);
  if (!createAndOpen) {
    result.errors.push('No create_and_open/createAndOpen/open export was found on @zvec/zvec.');
    result.wrapperAssessment = assessZvecNativeWrapper();
    return result;
  }

  const dir = await mkdtemp(join(tmpdir(), 'zincgraph-zvec-'));
  try {
    const Schema = moduleValue.ZVecCollectionSchema as
      | (new (params: {
          name: string;
          vectors?: UnknownRecord | UnknownRecord[];
          fields?: UnknownRecord | UnknownRecord[];
        }) => unknown)
      | undefined;
    const dataType = moduleValue.ZVecDataType as UnknownRecord | undefined;
    const indexType = moduleValue.ZVecIndexType as UnknownRecord | undefined;
    const metricType = moduleValue.ZVecMetricType as UnknownRecord | undefined;

    if (!Schema || !dataType || !indexType) {
      throw new Error('Zvec schema/data type exports are incomplete.');
    }

    const schema = new Schema({
      name: 'phase0',
      vectors: {
        name: 'embedding',
        dataType: dataType.VECTOR_FP32,
        dimension: 4,
        indexParams: {
          indexType: indexType.FLAT,
          metricType: metricType?.COSINE
        }
      },
      fields: {
        name: 'content',
        dataType: dataType.STRING,
        indexParams: {
          indexType: indexType.FTS
        }
      }
    });

    const collection = (await createAndOpen(join(dir, 'phase0'), schema)) as UnknownRecord;
    result.collectionCreated = Boolean(collection);

    const insert = functionAt(collection, ['insertSync', 'insert', 'upsertSync', 'upsert', 'add']);
    if (insert) {
      await insert([
        {
          id: 'phase0',
          vectors: { embedding: [0.1, 0.2, 0.3, 0.4] },
          fields: { content: 'zincgraph zvec probe test' }
        }
      ]);
      result.inserted = true;
    } else {
      result.errors.push('Collection does not expose insert/upsert/add.');
    }

    const query = functionAt(collection, ['querySync', 'query', 'search']);
    if (query) {
      await query({
        fieldName: 'embedding',
        vector: [0.4, 0.3, 0.2, 0.1],
        topk: 1
      });
      result.queried = true;
      await query({
        fieldName: 'content',
        fts: { matchString: 'zincgraph' },
        topk: 1,
        params: { indexType: indexType.FTS }
      });
      result.ftsQueried = true;
    } else {
      result.errors.push('Collection does not expose query/search.');
    }

    const close = functionAt(collection, ['closeSync', 'close']);
    await close?.();
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }

  const scenarioA = result.initialized && result.collectionCreated && result.inserted && result.queried;
  result.scenario = scenarioA ? 'A:npm-binding' : 'B:napi-wrapper-required';
  if (!scenarioA) {
    result.wrapperAssessment = assessZvecNativeWrapper();
  }
  return result;
}
