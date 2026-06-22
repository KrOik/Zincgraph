import type { ZincgraphToolDefinition } from '../mcp/tool-registry.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StabilizedTools {
  staticDefinitions: ToolDefinition[];
  dynamicMetadata: Record<string, unknown>;
  alignmentReport: AlignmentReport;
}

export interface AlignmentReport {
  dynamicFieldsDetected: string[];
  cacheablePrefixBytes: number;
  estimatedCacheHitRate: number;
}

export interface CacheAlignerAdapter {
  stabilize(toolDefinitions: ToolDefinition[]): StabilizedTools;
}

export interface CacheAlignerOptions {
  entropyThreshold?: number;
  extraDynamicLabels?: string[];
}

const DEFAULT_DYNAMIC_PATTERNS: RegExp[] = [
  /\/[A-Za-z]:\\/i,
  /\/home\/\w+/i,
  /\/Users\/\w+/i,
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i,
  /indexed_at/i,
  /session[_:]\s*\w+/i,
  /\b\d+\.\d+\.\d+\b/
];

const DEFAULT_DYNAMIC_LABELS = [
  'file_path',
  'file',
  'project',
  'cwd',
  'working_directory',
  'indexed_at',
  'session',
  'version',
  'timestamp'
];

export class CacheAligner implements CacheAlignerAdapter {
  private readonly dynamicPatterns: RegExp[];
  private readonly dynamicLabels: Set<string>;

  constructor(options: CacheAlignerOptions = {}) {
    this.dynamicPatterns = [...DEFAULT_DYNAMIC_PATTERNS];
    this.dynamicLabels = new Set([
      ...DEFAULT_DYNAMIC_LABELS,
      ...(options.extraDynamicLabels ?? [])
    ]);
  }

  stabilize(toolDefinitions: ToolDefinition[]): StabilizedTools {
    const dynamicFieldsDetected: string[] = [];
    const staticDefinitions: ToolDefinition[] = [];
    const dynamicMetadata: Record<string, unknown> = {};

    for (const tool of toolDefinitions) {
      const { staticDescription, extractedDescriptionFields } = this.stabilizeText(tool.description);
      const { staticSchema, extractedSchemaFields } = this.stabilizeSchema(tool.inputSchema);

      if (extractedDescriptionFields.length > 0 || extractedSchemaFields.length > 0) {
        const allExtracted = [...extractedDescriptionFields, ...extractedSchemaFields];
        dynamicFieldsDetected.push(...allExtracted.map((field) => `${tool.name}:${field}`));
        dynamicMetadata[tool.name] = {
          descriptionFields: extractedDescriptionFields,
          schemaFields: extractedSchemaFields
        };
      }

      staticDefinitions.push({
        name: tool.name,
        description: staticDescription,
        inputSchema: staticSchema
      });
    }

    const cacheablePrefixBytes = estimatePrefixBytes(staticDefinitions);
    const estimatedCacheHitRate = dynamicFieldsDetected.length > 0
      ? Math.min(0.95, 1 - (dynamicFieldsDetected.length / Math.max(1, toolDefinitions.length * 3)))
      : 0.95;

    return {
      staticDefinitions,
      dynamicMetadata,
      alignmentReport: {
        dynamicFieldsDetected,
        cacheablePrefixBytes,
        estimatedCacheHitRate
      }
    };
  }

  stabilizeFromZincgraphTools(tools: ZincgraphToolDefinition[]): StabilizedTools {
    const toolDefinitions: ToolDefinition[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>
    }));
    return this.stabilize(toolDefinitions);
  }

  private stabilizeText(text: string): { staticDescription: string; extractedDescriptionFields: string[] } {
    const extractedDescriptionFields: string[] = [];
    let staticDescription = text;

    for (const pattern of this.dynamicPatterns) {
      if (pattern.test(staticDescription)) {
        staticDescription = staticDescription.replace(pattern, '[DYNAMIC]');
        extractedDescriptionFields.push(`description:${pattern.source}`);
      }
    }

    return { staticDescription, extractedDescriptionFields };
  }

  private stabilizeSchema(
    schema: Record<string, unknown>
  ): { staticSchema: Record<string, unknown>; extractedSchemaFields: string[] } {
    const extractedSchemaFields: string[] = [];
    const staticSchema = deepClone(schema);
    const properties = staticSchema.properties;

    if (properties && typeof properties === 'object') {
      for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
        if (this.isDynamicField(key)) {
          extractedSchemaFields.push(`schema.property:${key}`);
        }
        if (value && typeof value === 'object') {
          const description = (value as Record<string, unknown>).description;
          if (typeof description === 'string') {
            for (const pattern of this.dynamicPatterns) {
              if (pattern.test(description)) {
                (value as Record<string, unknown>).description = description.replace(pattern, '[DYNAMIC]');
                extractedSchemaFields.push(`schema.description:${key}`);
              }
            }
          }
        }
      }
    }

    return { staticSchema, extractedSchemaFields };
  }

  private isDynamicField(fieldName: string): boolean {
    return this.dynamicLabels.has(fieldName.toLowerCase());
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function estimatePrefixBytes(definitions: ToolDefinition[]): number {
  const serialized = JSON.stringify(definitions);
  return Math.floor(serialized.length * 0.25);
}

export function createDefaultCacheAligner(): CacheAligner {
  return new CacheAligner();
}
