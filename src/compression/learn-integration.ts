import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SessionLog } from './feedback-store.js';

export type { SessionLog } from './feedback-store.js';

export type RuleFormat = 'agents-md' | 'claude-md' | 'gemini-md' | 'json';

export type FailurePatternType =
  | 'review-false-positive'
  | 'compression-over-aggressive'
  | 'empty-search'
  | 'stale-index';

export interface FailurePattern {
  type: FailurePatternType;
  occurrences: number;
  affectedFiles: string[];
  description: string;
  suggestedRule: string;
}

export interface GeneratedRule {
  type: FailurePatternType;
  text: string;
  confidence: number;
  evidenceCount: number;
}

export interface LearnResult {
  patterns: FailurePattern[];
  rules: GeneratedRule[];
  confidence: number;
}

export interface LearnIntegrationOptions {
  minOccurrences?: number;
}

export interface ApplyRulesOptions {
  dryRun?: boolean;
}

export interface LearnIntegrationAdapter {
  analyzeFailures(logs: SessionLog[]): LearnResult;
  generateRules(result: LearnResult, format: RuleFormat): string;
  applyRules(rules: string, targetPath: string, options?: ApplyRulesOptions): void;
}

interface PatternSeed {
  files: Set<string>;
  count: number;
}

const DEFAULT_MIN_OCCURRENCES = 3;
const GENERATED_BLOCK_START = '<!-- zincgraph:learn:START -->';
const GENERATED_BLOCK_END = '<!-- zincgraph:learn:END -->';

const PATTERN_DESCRIPTIONS: Record<FailurePatternType, { description: string; rule: string }> = {
  'review-false-positive': {
    description: 'Review output appears to contain findings later marked as ignored, already handled, or false positive.',
    rule: 'When surfacing review findings, include concrete graph evidence and avoid repeating findings already dismissed in the current project history.'
  },
  'compression-over-aggressive': {
    description: 'Compressed context was retrieved again, errored, or reported as missing details, indicating useful information may have been removed.',
    rule: 'When compressing review or code context, preserve file paths, symbol names, line anchors, and rationale needed to act without immediate retrieval.'
  },
  'empty-search': {
    description: 'Search or explore calls returned no useful results for non-empty queries.',
    rule: 'If a semantic or graph search returns empty results, broaden the query once and then inspect freshness/status before concluding the code is absent.'
  },
  'stale-index': {
    description: 'Tool output indicates stale, pending, missing, or out-of-date index state.',
    rule: 'Before relying on graph or semantic results, check index freshness and re-sync when status is stale, pending, missing, or out of date.'
  }
};

export class DeterministicLearnIntegrationAdapter implements LearnIntegrationAdapter {
  private readonly minOccurrences: number;

  constructor(options: LearnIntegrationOptions = {}) {
    this.minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  }

  analyzeFailures(logs: SessionLog[]): LearnResult {
    const seeds = new Map<FailurePatternType, PatternSeed>();

    for (const log of logs) {
      for (const type of classifySessionLog(log)) {
        const seed = seeds.get(type) ?? { files: new Set<string>(), count: 0 };
        seed.count += 1;
        for (const file of extractAffectedFiles(log)) {
          seed.files.add(file);
        }
        seeds.set(type, seed);
      }
    }

    const patterns = Array.from(seeds.entries())
      .filter(([, seed]) => seed.count >= this.minOccurrences)
      .map(([type, seed]) => ({
        type,
        occurrences: seed.count,
        affectedFiles: Array.from(seed.files).sort(),
        description: PATTERN_DESCRIPTIONS[type].description,
        suggestedRule: PATTERN_DESCRIPTIONS[type].rule
      }))
      .sort((a, b) => b.occurrences - a.occurrences || a.type.localeCompare(b.type));

    const totalOccurrences = patterns.reduce((sum, pattern) => sum + pattern.occurrences, 0);
    const confidence = patterns.length === 0 ? 0 : clamp(totalOccurrences / Math.max(logs.length, totalOccurrences), 0, 1);
    const rules = patterns.map((pattern) => ({
      type: pattern.type,
      text: pattern.suggestedRule,
      confidence: clamp(pattern.occurrences / Math.max(this.minOccurrences, pattern.occurrences + 1), 0, 1),
      evidenceCount: pattern.occurrences
    }));

    return { patterns, rules, confidence };
  }

  generateRules(result: LearnResult, format: RuleFormat): string {
    if (format === 'json') {
      return `${JSON.stringify(result, null, 2)}\n`;
    }

    const title = format === 'agents-md'
      ? '# Zincgraph Learned Agent Guidance'
      : format === 'claude-md'
        ? '# Zincgraph Learned Claude Guidance'
        : '# Zincgraph Learned Gemini Guidance';
    const lines = [
      GENERATED_BLOCK_START,
      title,
      '',
      'The following rules were generated from project-scoped Zincgraph MCP session logs.',
      ''
    ];

    if (result.rules.length === 0) {
      lines.push('- No recurring failure patterns met the configured minimum occurrence threshold.');
    } else {
      for (const rule of result.rules) {
        const pattern = result.patterns.find((candidate) => candidate.type === rule.type);
        const files = pattern && pattern.affectedFiles.length > 0 ? ` Affected files: ${pattern.affectedFiles.join(', ')}.` : '';
        lines.push(`- **${rule.type}** (${rule.evidenceCount} occurrence${rule.evidenceCount === 1 ? '' : 's'}, confidence ${rule.confidence.toFixed(2)}): ${rule.text}${files}`);
      }
    }

    lines.push(GENERATED_BLOCK_END, '');
    return lines.join('\n');
  }

  applyRules(rules: string, targetPath: string, options: ApplyRulesOptions = {}): void {
    if (options.dryRun) {
      return;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    if (!existsSync(targetPath)) {
      writeFileSync(targetPath, rules, 'utf8');
      return;
    }

    const existing = readFileSync(targetPath, 'utf8');
    const start = existing.indexOf(GENERATED_BLOCK_START);
    const end = existing.indexOf(GENERATED_BLOCK_END);
    if (start >= 0 && end >= start) {
      const afterEnd = end + GENERATED_BLOCK_END.length;
      const replacement = `${rules.trimEnd()}\n`;
      writeFileSync(targetPath, `${existing.slice(0, start)}${replacement}${existing.slice(afterEnd).replace(/^\n/, '')}`, 'utf8');
      return;
    }

    appendFileSync(targetPath, `${existing.endsWith('\n') ? '' : '\n'}\n${rules}`, 'utf8');
  }
}

export function createLearnIntegrationAdapter(options: LearnIntegrationOptions = {}): LearnIntegrationAdapter {
  return new DeterministicLearnIntegrationAdapter(options);
}

export function classifySessionLog(log: SessionLog): FailurePatternType[] {
  const structuredValues = collectSessionLogValues(log);
  const text = structuredValues
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  const types = new Set<FailurePatternType>();

  if (isReviewTool(log.toolName) && /false positive|ignored|dismissed|already (handled|covered|implemented)|not applicable|no action needed/.test(text)) {
    types.add('review-false-positive');
  }
  if ((log.toolName === 'zincgraph_retrieve' || /retrieve|compression|compressed/.test(text)) && /missing detail|lost context|too aggressive|over.?aggressive|insufficient context|no content found|not enough context/.test(text)) {
    types.add('compression-over-aggressive');
  }
  if (isSearchTool(log.toolName) && (hasEmptySearchPayload(structuredValues) || /\b(0 results|no results|no matches|not found)\b/.test(text))) {
    types.add('empty-search');
  }
  if (hasStaleIndexPayload(structuredValues) || /\bstale\b|out[- ]of[- ]date|pending sync|needs? (sync|reindex)|index missing|not indexed/.test(text)) {
    types.add('stale-index');
  }

  return Array.from(types).sort();
}

function isReviewTool(toolName: string): boolean {
  return ['zincgraph_review', 'zincgraph_audit', 'zincgraph_debt'].includes(toolName);
}

function isSearchTool(toolName: string): boolean {
  return ['zincgraph_explore', 'zincgraph_search', 'zincgraph_semantic_search', 'zincgraph_node', 'zincgraph_callers', 'zincgraph_callees'].includes(toolName);
}

function collectSessionLogValues(log: SessionLog): unknown[] {
  const values: unknown[] = [];
  for (const entry of [log.toolName, log.input, log.output, log.error ?? '']) {
    values.push(...collectNestedValues(entry));
  }
  return values;
}

function collectNestedValues(value: unknown, depth = 0): unknown[] {
  if (depth > 6) {
    return [];
  }
  if (typeof value === 'string') {
    const parsed = parseJsonMaybe(value);
    if (parsed === undefined) {
      return [value];
    }
    return [value, ...collectNestedValues(parsed, depth + 1)];
  }
  if (Array.isArray(value)) {
    return [value, ...value.flatMap((entry) => collectNestedValues(entry, depth + 1))];
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [value, ...Object.values(record).flatMap((entry) => collectNestedValues(entry, depth + 1))];
  }
  return [value];
}

function parseJsonMaybe(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function hasEmptySearchPayload(values: readonly unknown[]): boolean {
  return values.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      (Array.isArray(record.nodes) && record.nodes.length === 0) ||
      (Array.isArray(record.documents) && record.documents.length === 0)
    );
  });
}

function hasStaleIndexPayload(values: readonly unknown[]): boolean {
  return values.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const freshness = record.freshness as Record<string, unknown> | undefined;
    if (freshness && freshness.isFresh === false) {
      return true;
    }
    if (record.freshnessState === 'stale' || record.freshnessState === 'non-fresh') {
      return true;
    }
    return record.state === 'stale' || record.state === 'out-of-date' || record.state === 'pending';
  });
}

function extractAffectedFiles(log: SessionLog): string[] {
  const seen = new Set<string>();
  const text = `${log.input}\n${log.output}`;
  const filePattern = /(?:^|[\s"'`(])([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|sh|yaml|yml|toml))(?:$|[\s"'`):,])/g;
  for (const match of text.matchAll(filePattern)) {
    if (match[1]) {
      seen.add(match[1]);
    }
  }
  return Array.from(seen).sort();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
