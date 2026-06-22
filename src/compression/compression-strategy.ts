import type { FusionNode } from '../fusion/query-engine.js';

export type CompressionStrategyName = 'smart-crusher' | 'code-compressor' | 'intelligent-context' | 'pipeline';

export interface CompressionStrategyResult {
  strategy: CompressionStrategyName;
  compressed: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface CompressionStrategyOptions {
  maxTokens: number;
  strategy?: 'auto' | 'aggressive' | 'conservative' | 'off';
}

export function detectContentType(content: string): 'json' | 'code' | 'text' {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return 'text';
  }
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && looksLikeJson(trimmed)) {
    return 'json';
  }
  if (hasCodeSignals(trimmed)) {
    return 'code';
  }
  return 'text';
}

function looksLikeJson(trimmed: string): boolean {
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return trimmed.length > 20 && /["':\[\]{}]/.test(trimmed.slice(0, 100));
  }
}

function hasCodeSignals(content: string): boolean {
  const head = content.slice(0, 300);
  return /\b(function|class|const|let|var|import|export|return|if|else|for|while|async|await|interface|type|enum)\b/.test(head)
    || /[{}();]\s*$/.test(head.split('\n')[0] ?? '');
}

export function selectStrategy(node: FusionNode, options: CompressionStrategyOptions): CompressionStrategyName {
  if (options.strategy === 'off') {
    return 'intelligent-context';
  }
  const contentType = detectContentType(node.content);
  switch (contentType) {
    case 'json':
      return 'smart-crusher';
    case 'code':
      return 'code-compressor';
    case 'text':
    default:
      return 'intelligent-context';
  }
}

export function applyStrategy(
  content: string,
  strategy: CompressionStrategyName,
  maxTokens: number
): CompressionStrategyResult {
  const tokensBefore = estimateTokens(content);
  if (tokensBefore <= maxTokens) {
    return { strategy, compressed: content, tokensBefore, tokensAfter: tokensBefore };
  }

  let compressed: string;
  switch (strategy) {
    case 'smart-crusher':
      compressed = smartCrusherCompress(content, maxTokens);
      break;
    case 'code-compressor':
      compressed = codeCompressorCompress(content, maxTokens);
      break;
    case 'intelligent-context':
    case 'pipeline':
    default:
      compressed = intelligentContextCompress(content, maxTokens);
      break;
  }

  return { strategy, compressed, tokensBefore, tokensAfter: estimateTokens(compressed) };
}

function smartCrusherCompress(content: string, maxTokens: number): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const compact = JSON.stringify(parsed);
      if (estimateTokens(compact) <= maxTokens) {
        return compact;
      }
      const ratio = maxTokens / estimateTokens(compact);
      const keptCount = Math.max(1, Math.floor(parsed.length * ratio));
      const summary = {
        __compressed: true,
        totalItems: parsed.length,
        shownItems: keptCount,
        items: parsed.slice(0, keptCount)
      };
      return JSON.stringify(summary);
    }
    const compact = JSON.stringify(parsed);
    return truncateToTokens(compact, maxTokens);
  } catch {
    return truncateToTokens(content, maxTokens);
  }
}

function codeCompressorCompress(content: string, maxTokens: number): string {
  const lines = content.split('\n');
  const signatureLines: string[] = [];
  const bodyStart: number[] = [];

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]?.trim() ?? '';
    if (
      /^(export\s+|import\s+|function\s+|class\s+|const\s+|let\s+|var\s+|async\s+|interface\s+|type\s+|enum\s+)/.test(trimmed)
      || /^\s*(public|private|protected|static)\s+/.test(trimmed)
    ) {
      signatureLines.push(lines[index] ?? '');
    } else {
      bodyStart.push(index);
    }
  }

  const signatureText = signatureLines.join('\n');
  const signatureTokens = estimateTokens(signatureText);

  if (signatureTokens >= maxTokens) {
    return truncateToTokens(signatureText, maxTokens);
  }

  const remainingBudget = maxTokens - signatureTokens;
  const bodyLines = bodyStart.map((index) => lines[index] ?? '');
  const bodyText = bodyLines.join('\n');
  const bodyTokens = estimateTokens(bodyText);

  if (bodyTokens <= remainingBudget) {
    return content;
  }

  const ratio = remainingBudget / bodyTokens;
  const keptLines = Math.max(1, Math.floor(bodyLines.length * ratio));
  return [...signatureLines, ...bodyLines.slice(0, keptLines), `// ... ${bodyLines.length - keptLines} lines compressed`].join('\n');
}

function intelligentContextCompress(content: string, maxTokens: number): string {
  const lines = content.split('\n');
  const tokensPerLine = lines.map((line) => estimateTokens(line));
  const totalTokens = tokensPerLine.reduce((sum, count) => sum + count, 0);

  if (totalTokens <= maxTokens) {
    return content;
  }

  const scored = lines.map((line, index) => ({
    line,
    index,
    score: scoreLineImportance(line, index, lines.length)
  }));

  const sorted = [...scored].sort((left, right) => right.score - left.score);
  const kept: typeof scored = [];
  let usedTokens = 0;

  for (const item of sorted) {
    const lineTokens = tokensPerLine[item.index] ?? 0;
    if (usedTokens + lineTokens > maxTokens) {
      continue;
    }
    kept.push(item);
    usedTokens += lineTokens;
  }

  kept.sort((left, right) => left.index - right.index);
  const result = kept.map((item) => item.line).join('\n');
  return result || truncateToTokens(content, maxTokens);
}

function scoreLineImportance(line: string, index: number, totalLines: number): number {
  let score = 0;
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return -1;
  }
  if (/^(import|export|from)\s/.test(trimmed)) {
    score += 3;
  }
  if (/^(function|class|interface|type|enum|const|let|var)\s/.test(trimmed)) {
    score += 5;
  }
  if (/^\s*(if|else|for|while|return|throw)\b/.test(trimmed)) {
    score += 2;
  }
  if (index < 3 || index >= totalLines - 2) {
    score += 2;
  }
  if (/TODO|FIXME|HACK|XXX/.test(trimmed)) {
    score += 4;
  }
  return score;
}

function truncateToTokens(content: string, maxTokens: number): string {
  const words = content.trim().split(/\s+/);
  if (words.length <= maxTokens) {
    return content;
  }
  return words.slice(0, maxTokens).join(' ') + ' ... [compressed]';
}

export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, words.length);
}
