import { spawnSync } from 'node:child_process';

export type HeadroomScenario = 'A:npm-sdk' | 'B:proxy-http' | 'C:python-cli';

export interface HeadroomFallbackAssessment {
  proxyEndpoint: string;
  pythonCliAvailable: boolean;
  estimatedEffort: string;
  risks: string[];
}

export interface HeadroomProbeResult {
  scenario: HeadroomScenario;
  packageAvailable: boolean;
  exports: string[];
  compressWorks: boolean;
  ccrAvailable: boolean;
  mcpToolsAvailable: boolean;
  relevanceScorerAvailable: boolean;
  cacheAlignerAvailable: boolean;
  errors: string[];
  fallbackAssessment?: HeadroomFallbackAssessment;
}

type UnknownRecord = Record<string, unknown>;

async function loadHeadroom(): Promise<UnknownRecord> {
  return (await import('headroom-ai')) as unknown as UnknownRecord;
}

export async function isHeadroomPackageLoadable(): Promise<boolean> {
  try {
    await loadHeadroom();
    return true;
  } catch {
    return false;
  }
}

export function assessHeadroomFallback(): HeadroomFallbackAssessment {
  const pythonCliAvailable = checkPythonCli();
  return {
    proxyEndpoint: 'POST /v1/chat/completions',
    pythonCliAvailable,
    estimatedEffort: '1-2 days',
    risks: [
      'Headroom proxy requires a running server or API key',
      'Python CLI fallback adds process spawn overhead'
    ]
  };
}

function checkPythonCli(): boolean {
  try {
    const result = spawnSync('headroom', ['--version'], { encoding: 'utf8', timeout: 5_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

export async function probeHeadroom(options: { runCompress?: boolean } = {}): Promise<HeadroomProbeResult> {
  const result: HeadroomProbeResult = {
    scenario: 'C:python-cli',
    packageAvailable: false,
    exports: [],
    compressWorks: false,
    ccrAvailable: false,
    mcpToolsAvailable: false,
    relevanceScorerAvailable: false,
    cacheAlignerAvailable: false,
    errors: []
  };

  let moduleValue: UnknownRecord;
  try {
    moduleValue = await loadHeadroom();
    result.packageAvailable = true;
    result.exports = Object.keys(moduleValue).sort();
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.fallbackAssessment = assessHeadroomFallback();
    return result;
  }

  const hasCompress = typeof moduleValue.compress === 'function';
  const hasHeadroomClient = typeof moduleValue.HeadroomClient === 'function';
  const hasSharedContext = typeof moduleValue.SharedContext === 'function';

  if (!hasCompress) {
    result.errors.push('headroom-ai does not export a compress function.');
    result.fallbackAssessment = assessHeadroomFallback();
    return result;
  }

  result.relevanceScorerAvailable = result.exports.some(
    (name) => /relevance/i.test(name) || /scorer/i.test(name)
  );
  result.cacheAlignerAvailable = result.exports.some(
    (name) => /cacheAligner/i.test(name) || /cache.*align/i.test(name)
  );
  result.ccrAvailable = hasSharedContext || result.exports.some((name) => /ccr/i.test(name));
  result.mcpToolsAvailable = hasHeadroomClient;

  if (!options.runCompress) {
    result.scenario = 'A:npm-sdk';
    return result;
  }

  try {
    const compress = moduleValue.compress as (
      messages: unknown[],
      options?: { model?: string; tokenBudget?: number }
    ) => Promise<UnknownRecord>;
    const testMessages = [
      { role: 'user', content: 'Test message for headroom compression probe.' }
    ];
    const compressResult = await compress(testMessages, { model: 'gpt-4o-mini', tokenBudget: 500 });
    result.compressWorks =
      typeof compressResult.tokensBefore === 'number' &&
      typeof compressResult.tokensAfter === 'number';
  } catch (error) {
    result.errors.push(
      `compress() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (result.compressWorks) {
    result.scenario = 'A:npm-sdk';
  } else {
    result.scenario = 'B:proxy-http';
    result.fallbackAssessment = assessHeadroomFallback();
  }

  return result;
}

export interface HeadroomCompressInput {
  messages: unknown[];
  model?: string;
  tokenBudget?: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface HeadroomCompressOutput {
  messages: unknown[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  transformsApplied: string[];
  ccrHashes: string[];
  compressed: boolean;
}

let cachedCompress: ((messages: unknown[], options?: unknown) => Promise<unknown>) | null = null;

async function getCompressFunction(): Promise<(messages: unknown[], options?: unknown) => Promise<unknown>> {
  if (cachedCompress) {
    return cachedCompress;
  }
  const moduleValue = await loadHeadroom();
  const compress = moduleValue.compress;
  if (typeof compress !== 'function') {
    throw new Error('headroom-ai does not export compress');
  }
  cachedCompress = compress as (messages: unknown[], options?: unknown) => Promise<unknown>;
  return cachedCompress;
}

export async function compressMessages(input: HeadroomCompressInput): Promise<HeadroomCompressOutput> {
  const compress = await getCompressFunction();
  const options: Record<string, unknown> = {};
  if (input.model) {
    options.model = input.model;
  }
  if (input.tokenBudget !== undefined) {
    options.tokenBudget = input.tokenBudget;
  }
  if (input.baseUrl) {
    options.baseUrl = input.baseUrl;
  }
  if (input.apiKey) {
    options.apiKey = input.apiKey;
  }
  const result = (await compress(input.messages, options)) as HeadroomCompressOutput;
  return {
    messages: result.messages ?? input.messages,
    tokensBefore: result.tokensBefore ?? 0,
    tokensAfter: result.tokensAfter ?? 0,
    tokensSaved: result.tokensSaved ?? 0,
    compressionRatio: result.compressionRatio ?? 0,
    transformsApplied: result.transformsApplied ?? [],
    ccrHashes: result.ccrHashes ?? [],
    compressed: result.compressed ?? false
  };
}

export async function compressContentLocal(
  content: string,
  contentType: 'code' | 'json' | 'text' | 'auto',
  maxTokens: number
): Promise<{ compressed: string; tokensBefore: number; tokensAfter: number; hash: string }> {
  const resolvedType = contentType === 'auto' ? detectContentType(content) : contentType;
  const tokensBefore = estimateTokens(content);

  let compressed: string;
  switch (resolvedType) {
    case 'json':
      compressed = compressJson(content, maxTokens);
      break;
    case 'code':
      compressed = compressCode(content, maxTokens);
      break;
    case 'text':
    default:
      compressed = compressText(content, maxTokens);
      break;
  }

  const tokensAfter = estimateTokens(compressed);
  const hash = await sha256Short(content);

  return { compressed, tokensBefore, tokensAfter, hash };
}

function detectContentType(content: string): 'code' | 'json' | 'text' {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // not valid JSON
    }
  }
  if (/\b(function|class|const|let|var|import|export|return|if|else|for|while)\b/.test(trimmed.slice(0, 200))) {
    return 'code';
  }
  return 'text';
}

function compressJson(content: string, maxTokens: number): string {
  try {
    const parsed = JSON.parse(content);
    const compact = JSON.stringify(parsed);
    const tokenEstimate = estimateTokens(compact);
    if (tokenEstimate <= maxTokens) {
      return compact;
    }
    const ratio = maxTokens / tokenEstimate;
    const maxLength = Math.floor(compact.length * ratio);
    return compact.slice(0, maxLength) + '... [compressed]';
  } catch {
    return compressText(content, maxTokens);
  }
}

function compressCode(content: string, maxTokens: number): string {
  const lines = content.split('\n');
  const signatureLines: string[] = [];
  const bodyLines: string[] = [];
  let inSignature = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inSignature && /^(export |import |function |class |const |let |var |async |interface |type )/.test(trimmed)) {
      signatureLines.push(line);
      if (trimmed.endsWith('{') || trimmed.endsWith('(') || trimmed.endsWith(';')) {
        inSignature = trimmed.endsWith(';');
      }
    } else {
      inSignature = false;
      bodyLines.push(line);
    }
  }

  const tokenBudget = maxTokens;
  const signatureTokens = estimateTokens(signatureLines.join('\n'));

  if (signatureTokens >= tokenBudget) {
    return signatureLines.join('\n');
  }

  const remainingBudget = tokenBudget - signatureTokens;
  const bodyText = bodyLines.join('\n');
  const bodyTokens = estimateTokens(bodyText);

  if (bodyTokens <= remainingBudget) {
    return content;
  }

  const ratio = remainingBudget / bodyTokens;
  const keptLines = Math.max(1, Math.floor(bodyLines.length * ratio));
  return [...signatureLines, ...bodyLines.slice(0, keptLines), `// ... ${bodyLines.length - keptLines} lines compressed`].join('\n');
}

function compressText(content: string, maxTokens: number): string {
  const tokenEstimate = estimateTokens(content);
  if (tokenEstimate <= maxTokens) {
    return content;
  }
  const words = content.trim().split(/\s+/);
  const kept = Math.max(1, Math.floor(words.length * (maxTokens / tokenEstimate)));
  return words.slice(0, kept).join(' ') + ' ... [compressed]';
}

function estimateTokens(text: string): number {
  return Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
}

async function sha256Short(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
