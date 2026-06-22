import { spawnSync } from 'node:child_process';

import { readCodeGraphSnapshot, type CodeGraphSnapshot, type CodeGraphSnapshotNode } from '../vector/code-to-vectors.js';

export type GraphReviewFindingType =
  | 'same-signature'
  | 'redundant-import'
  | 'yagni'
  | 'similar-class'
  | 'dead-code'
  | 'cycle-dependency';

export type GraphReviewSeverity = 'info' | 'warning' | 'error';

export interface GraphReviewFinding {
  type: GraphReviewFindingType;
  severity: GraphReviewSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface AddedFunctionDeclaration {
  name: string;
  signature: string;
  filePath?: string | undefined;
}

export interface AddedImportDeclaration {
  moduleName: string;
  importName?: string | undefined;
  localName?: string | undefined;
  filePath?: string | undefined;
}

export interface AddedClassDeclaration {
  name: string;
  signature: string;
  extendsName?: string | undefined;
  implementsNames: string[];
  filePath?: string | undefined;
}

export interface GraphReviewAdditions {
  functions: AddedFunctionDeclaration[];
  imports: AddedImportDeclaration[];
  classes: AddedClassDeclaration[];
}

export interface RedundantImportEvidence {
  moduleName: string;
  importName?: string | undefined;
  via: string;
  filePath?: string | undefined;
  reason?: string | undefined;
}

export interface ClassHierarchyEvidence {
  className: string;
  qualifiedName?: string | undefined;
  filePath: string;
  line?: number | undefined;
  extendsName?: string | undefined;
  implementsNames?: readonly string[] | undefined;
  signature?: string | undefined;
}

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface GraphEvidenceOptions {
  redundantImports?: readonly RedundantImportEvidence[];
  callers?: Readonly<Record<string, readonly string[]>>;
  classHierarchies?: readonly ClassHierarchyEvidence[];
  dependencyEdges?: readonly DependencyEdge[];
  publicNodeIds?: readonly string[];
  publicQualifiedNames?: readonly string[];
  lineByNodeId?: Readonly<Record<string, number>>;
}

export interface AnalyzeGraphReviewOptions {
  snapshot: CodeGraphSnapshot;
  diffText?: string | undefined;
  additions?: Partial<GraphReviewAdditions> | undefined;
  evidence?: GraphEvidenceOptions | undefined;
  yagniCallerThreshold?: number | undefined;
}

export interface GraphReviewResult {
  findings: GraphReviewFinding[];
  reviewFindings: GraphReviewFinding[];
  auditFindings: GraphReviewFinding[];
  additions: GraphReviewAdditions;
}

const DEFAULT_YAGNI_CALLER_THRESHOLD = 1;
const REVIEW_KINDS = new Set<GraphReviewFindingType>([
  'same-signature',
  'redundant-import',
  'yagni',
  'similar-class'
]);

export class GraphReviewAnalyzer {
  analyze(options: AnalyzeGraphReviewOptions): GraphReviewResult {
    const additions = mergeAdditions(parseAddedDeclarations(options.diffText ?? ''), options.additions ?? {});
    const reviewFindings = [
      ...findSameSignatureFunctions(options.snapshot, additions, options.evidence),
      ...findRedundantImports(additions, options.evidence),
      ...findYagniAbstractions(options.snapshot, additions, options.evidence, options.yagniCallerThreshold ?? DEFAULT_YAGNI_CALLER_THRESHOLD),
      ...findSimilarClasses(options.snapshot, additions, options.evidence)
    ];
    const auditFindings = [
      ...findDeadCode(options.snapshot, options.evidence),
      ...findDependencyCycles(options.snapshot, options.evidence)
    ];
    const findings = [...reviewFindings, ...auditFindings];
    return { findings, reviewFindings, auditFindings, additions };
  }

  analyzeReview(options: AnalyzeGraphReviewOptions): GraphReviewFinding[] {
    return this.analyze(options).findings.filter((finding) => REVIEW_KINDS.has(finding.type));
  }

  analyzeAudit(options: AnalyzeGraphReviewOptions): GraphReviewFinding[] {
    return this.analyze(options).findings.filter((finding) => !REVIEW_KINDS.has(finding.type));
  }
}

export function analyzeGraphReview(options: AnalyzeGraphReviewOptions): GraphReviewResult {
  return new GraphReviewAnalyzer().analyze(options);
}

export function parseAddedDeclarations(diffText: string): GraphReviewAdditions {
  const additions: GraphReviewAdditions = { functions: [], imports: [], classes: [] };
  let currentFile: string | undefined;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      currentFile = normalizeDiffPath(rawLine.slice(4).trim());
      continue;
    }
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) {
      continue;
    }
    const line = rawLine.slice(1).trim();
    if (!line || line.startsWith('//')) {
      continue;
    }
    const importDeclarations = parseImportLine(line, currentFile);
    additions.imports.push(...importDeclarations);
    const fn = parseFunctionLine(line, currentFile);
    if (fn) {
      additions.functions.push(fn);
    }
    const klass = parseClassLine(line, currentFile);
    if (klass) {
      additions.classes.push(klass);
    }
  }

  return additions;
}

export function formatGraphReviewFindings(findings: readonly GraphReviewFinding[]): string[] {
  if (findings.length === 0) {
    return ['Zincgraph graph evidence: none'];
  }
  return [
    `Zincgraph graph evidence: ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    ...findings.map((finding) => `- [${finding.type}] ${finding.message}`)
  ];
}

export function readGitDiff(projectPath: string): string {
  const result = spawnSync('git', ['diff', '--no-ext-diff'], {
    cwd: projectPath,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`git diff unavailable: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`git diff unavailable: git diff terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? `exit status ${result.status ?? 'unknown'}`;
    throw new Error(`git diff unavailable: ${detail}`);
  }
  return result.stdout;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function loadSnapshotForReview(projectPath: string): CodeGraphSnapshot {
  return readCodeGraphSnapshot(projectPath);
}

function mergeAdditions(parsed: GraphReviewAdditions, explicit: Partial<GraphReviewAdditions>): GraphReviewAdditions {
  return {
    functions: [...parsed.functions, ...(explicit.functions ?? [])],
    imports: [...parsed.imports, ...(explicit.imports ?? [])],
    classes: [...parsed.classes, ...(explicit.classes ?? [])]
  };
}

function parseImportLine(line: string, filePath: string | undefined): AddedImportDeclaration[] {
  const fromMatch = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(line);
  if (fromMatch?.[1] && fromMatch[2]) {
    const imports = fromMatch[1].trim();
    const moduleName = fromMatch[2];
    if (imports.startsWith('{') && imports.endsWith('}')) {
      return imports
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const [importName, localName] = item.split(/\s+as\s+/i).map((part) => part.trim());
          return { moduleName, importName, localName: localName ?? importName, filePath };
        });
    }
    if (imports.startsWith('* as ')) {
      const localName = imports.slice(5).trim();
      return [{ moduleName, importName: '*', localName, filePath }];
    }
    const defaultName = imports.split(',')[0]?.trim();
    return defaultName ? [{ moduleName, importName: 'default', localName: defaultName, filePath }] : [];
  }

  const sideEffectMatch = /^import\s+['"]([^'"]+)['"]/.exec(line);
  return sideEffectMatch?.[1] ? [{ moduleName: sideEffectMatch[1], filePath }] : [];
}

function parseFunctionLine(line: string, filePath: string | undefined): AddedFunctionDeclaration | null {
  const declaration = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^ {;]+(?:\s*[^ {;]+)*))?/.exec(line);
  if (declaration?.[1]) {
    const returnType = declaration[3]?.trim();
    return {
      name: declaration[1],
      signature: `function ${declaration[1]}(${normalizeSpaces(declaration[2] ?? '')})${returnType ? `: ${returnType}` : ''}`,
      filePath
    };
  }

  const arrow = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::\s*([^=]+?))?\s*=>/.exec(line);
  if (arrow?.[1]) {
    const params = normalizeSpaces(arrow[2] ?? arrow[3] ?? '');
    const returnType = arrow[4]?.trim();
    return {
      name: arrow[1],
      signature: `function ${arrow[1]}(${params})${returnType ? `: ${returnType}` : ''}`,
      filePath
    };
  }
  return null;
}

function parseClassLine(line: string, filePath: string | undefined): AddedClassDeclaration | null {
  const match = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?(?:\s+implements\s+([^<{]+(?:<[^>]+>)?[^ {]*))?/.exec(line);
  if (!match?.[1]) {
    return null;
  }
  const implementsNames = splitImplements(match[3]);
  const signature = [
    `class ${match[1]}`,
    match[2] ? `extends ${match[2]}` : '',
    implementsNames.length > 0 ? `implements ${implementsNames.join(', ')}` : ''
  ].filter(Boolean).join(' ');
  return {
    name: match[1],
    signature,
    ...(match[2] ? { extendsName: match[2] } : {}),
    implementsNames,
    filePath
  };
}

function findSameSignatureFunctions(
  snapshot: CodeGraphSnapshot,
  additions: GraphReviewAdditions,
  evidence: GraphEvidenceOptions | undefined
): GraphReviewFinding[] {
  const findings: GraphReviewFinding[] = [];
  for (const added of additions.functions) {
    const normalizedAdded = normalizeSignature(added.signature);
    const existing = snapshot.nodes.find((node) =>
      ['function', 'method'].includes(node.kind) &&
      node.signature &&
      normalizeSignature(node.signature) === normalizedAdded
    );
    if (!existing) {
      continue;
    }
    const location = nodeLocation(existing, evidence);
    findings.push({
      type: 'same-signature',
      severity: 'warning',
      message: `Existing same-signature function ${existing.qualifiedName} at ${location}; reuse it instead of adding ${added.name}.`,
      evidence: { added, existing: nodeEvidence(existing, evidence), location }
    });
  }
  return findings;
}

function findRedundantImports(
  additions: GraphReviewAdditions,
  evidence: GraphEvidenceOptions | undefined
): GraphReviewFinding[] {
  const known = evidence?.redundantImports ?? [];
  const findings: GraphReviewFinding[] = [];
  for (const added of additions.imports) {
    const match = known.find((candidate) =>
      candidate.moduleName === added.moduleName &&
      (!candidate.importName || !added.importName || candidate.importName === added.importName || candidate.importName === added.localName)
    );
    if (!match) {
      continue;
    }
    const imported = added.importName && added.importName !== 'default' ? `${added.importName} from ${added.moduleName}` : added.moduleName;
    findings.push({
      type: 'redundant-import',
      severity: 'info',
      message: `Redundant import ${imported}: equivalent functionality is already available via ${match.via}${match.filePath ? ` (${match.filePath})` : ''}.`,
      evidence: { added, redundantImport: match }
    });
  }
  return findings;
}

function findYagniAbstractions(
  snapshot: CodeGraphSnapshot,
  additions: GraphReviewAdditions,
  evidence: GraphEvidenceOptions | undefined,
  threshold: number
): GraphReviewFinding[] {
  const findings: GraphReviewFinding[] = [];
  const candidates = [
    ...additions.classes.map((klass) => ({ name: klass.name, kind: 'class', declaration: klass })),
    ...additions.functions.map((fn) => ({ name: fn.name, kind: 'function', declaration: fn }))
  ];
  for (const candidate of candidates) {
    if (!hasCallerEvidence(candidate.declaration, evidence)) {
      continue;
    }
    const callers = callersForDeclaration(snapshot, candidate.declaration, evidence);
    if (callers.length > threshold) {
      continue;
    }
    findings.push({
      type: 'yagni',
      severity: 'warning',
      message: `YAGNI evidence for ${candidate.name}: only ${callers.length} caller${callers.length === 1 ? '' : 's'}; suggest inlining until reuse grows.`,
      evidence: { abstraction: candidate.declaration, callerCount: callers.length, callers, threshold }
    });
  }
  return findings;
}

function hasCallerEvidence(
  declaration: AddedFunctionDeclaration | AddedClassDeclaration,
  evidence: GraphEvidenceOptions | undefined
): boolean {
  return callerEvidenceKeys(declaration).some((key) => Object.prototype.hasOwnProperty.call(evidence?.callers ?? {}, key));
}

function findSimilarClasses(
  snapshot: CodeGraphSnapshot,
  additions: GraphReviewAdditions,
  evidence: GraphEvidenceOptions | undefined
): GraphReviewFinding[] {
  const existingClasses = [
    ...(evidence?.classHierarchies ?? []),
    ...snapshot.nodes.filter((node) => node.kind === 'class').map(classEvidenceFromNode)
  ].filter(hasHierarchyEvidence);

  const findings: GraphReviewFinding[] = [];
  for (const added of additions.classes) {
    if (!added.extendsName && added.implementsNames.length === 0) {
      continue;
    }
    const match = existingClasses.find((candidate) =>
      candidate.className !== added.name &&
      sameHierarchy(added.extendsName, added.implementsNames, candidate.extendsName, candidate.implementsNames ?? [])
    );
    if (!match) {
      continue;
    }
    const location = `${match.filePath}${match.line ? `:${match.line}` : ''}`;
    findings.push({
      type: 'similar-class',
      severity: 'info',
      message: `Similar class hierarchy already exists in ${match.qualifiedName ?? match.className} at ${location}; check before adding ${added.name}.`,
      evidence: { added, existing: match, location }
    });
  }
  return findings;
}

function findDeadCode(snapshot: CodeGraphSnapshot, evidence: GraphEvidenceOptions | undefined): GraphReviewFinding[] {
  const publicNodeIds = new Set(evidence?.publicNodeIds ?? []);
  const publicQualifiedNames = new Set(evidence?.publicQualifiedNames ?? []);
  const reverse = reverseCallMap(snapshot);
  return snapshot.nodes
    .filter((node) => ['function', 'method', 'class'].includes(node.kind))
    .filter((node) => !publicNodeIds.has(node.id) && !publicQualifiedNames.has(node.qualifiedName))
    .filter((node) => (reverse.get(node.name)?.length ?? 0) === 0 && (reverse.get(node.qualifiedName)?.length ?? 0) === 0)
    .map((node) => ({
      type: 'dead-code' as const,
      severity: 'info' as const,
      message: `Audit dead-code evidence: ${node.qualifiedName} has no graph callers.`,
      evidence: { node: nodeEvidence(node, evidence), callerCount: 0 }
    }));
}

function findDependencyCycles(snapshot: CodeGraphSnapshot, evidence: GraphEvidenceOptions | undefined): GraphReviewFinding[] {
  const edges = evidence?.dependencyEdges?.length ? [...evidence.dependencyEdges] : deriveFileDependencyEdges(snapshot);
  const cycles = findDirectedCycles(edges);
  return cycles.map((cycle) => ({
    type: 'cycle-dependency' as const,
    severity: 'warning' as const,
    message: `Audit cycle-dependency evidence: ${cycle.join(' -> ')}.`,
    evidence: { cycle, edges }
  }));
}

function callersForDeclaration(
  snapshot: CodeGraphSnapshot,
  declaration: AddedFunctionDeclaration | AddedClassDeclaration,
  evidence: GraphEvidenceOptions | undefined
): string[] {
  for (const key of callerEvidenceKeys(declaration)) {
    const injected = evidence?.callers?.[key];
    if (injected) {
      return [...injected];
    }
  }
  const reverse = reverseCallMap(snapshot);
  return [...new Set([...(reverse.get(declaration.name) ?? []), ...(reverse.get(`::${declaration.name}`) ?? [])])];
}

function callerEvidenceKeys(declaration: AddedFunctionDeclaration | AddedClassDeclaration): string[] {
  const keys: string[] = [];
  if (declaration.filePath) {
    keys.push(`${declaration.filePath}::${declaration.name}`);
  }
  keys.push(declaration.signature);
  keys.push(declaration.name);
  return [...new Set(keys.filter(Boolean))];
}

function reverseCallMap(snapshot: CodeGraphSnapshot): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const namesByCall = new Map<string, string>();
  for (const node of snapshot.nodes) {
    namesByCall.set(node.name, node.name);
    namesByCall.set(node.qualifiedName, node.name);
    namesByCall.set(node.qualifiedName.split('::').at(-1) ?? node.name, node.name);
  }
  for (const node of snapshot.nodes) {
    for (const call of node.calls) {
      const keys = new Set([call, namesByCall.get(call) ?? call, call.split('::').at(-1) ?? call]);
      for (const key of keys) {
        const callers = map.get(key) ?? [];
        callers.push(node.qualifiedName);
        map.set(key, callers);
      }
    }
  }
  return map;
}

function deriveFileDependencyEdges(snapshot: CodeGraphSnapshot): DependencyEdge[] {
  const byName = new Map<string, CodeGraphSnapshotNode>();
  for (const node of snapshot.nodes) {
    byName.set(node.name, node);
    byName.set(node.qualifiedName, node);
    byName.set(node.qualifiedName.split('::').at(-1) ?? node.name, node);
  }
  const edges: DependencyEdge[] = [];
  for (const node of snapshot.nodes) {
    for (const call of node.calls) {
      const target = byName.get(call) ?? byName.get(call.split('::').at(-1) ?? call);
      if (target && target.filePath !== node.filePath) {
        edges.push({ from: node.filePath, to: target.filePath });
      }
    }
  }
  return edges;
}

function findDirectedCycles(edges: readonly DependencyEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, new Set());
    }
    adjacency.get(edge.from)?.add(edge.to);
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, new Set());
    }
  }
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: string, path: string[]) => {
    const index = path.indexOf(node);
    if (index >= 0) {
      const cycle = [...path.slice(index), node];
      const key = canonicalCycleKey(cycle);
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    for (const next of adjacency.get(node) ?? []) {
      visit(next, [...path, node]);
    }
  };
  for (const node of [...adjacency.keys()].sort()) {
    visit(node, []);
  }
  return cycles;
}

function canonicalCycleKey(cycle: readonly string[]): string {
  const withoutDuplicateEnd = cycle[0] === cycle.at(-1) ? cycle.slice(0, -1) : [...cycle];
  const rotations = withoutDuplicateEnd.map((_, index) => [
    ...withoutDuplicateEnd.slice(index),
    ...withoutDuplicateEnd.slice(0, index)
  ].join('>'));
  return rotations.sort()[0] ?? withoutDuplicateEnd.join('>');
}

function classEvidenceFromNode(node: CodeGraphSnapshotNode): ClassHierarchyEvidence {
  const parsed = parseClassLine(node.signature ?? '', node.filePath);
  return {
    className: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    signature: node.signature,
    ...(parsed?.extendsName ? { extendsName: parsed.extendsName } : {}),
    implementsNames: parsed?.implementsNames ?? []
  };
}

function hasHierarchyEvidence(candidate: ClassHierarchyEvidence): boolean {
  return Boolean(candidate.extendsName || candidate.implementsNames?.length);
}

function sameHierarchy(
  leftExtends: string | undefined,
  leftImplements: readonly string[],
  rightExtends: string | undefined,
  rightImplements: readonly string[]
): boolean {
  const extendsMatch = Boolean(leftExtends && rightExtends && normalizeName(leftExtends) === normalizeName(rightExtends));
  const leftSet = new Set(leftImplements.map(normalizeName));
  const sharedInterfaces = rightImplements.map(normalizeName).filter((name) => leftSet.has(name));
  return extendsMatch || (leftSet.size > 0 && sharedInterfaces.length === leftSet.size);
}

function splitImplements(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim().replace(/\s*\{.*$/, ''))
    .filter(Boolean);
}

function nodeLocation(node: CodeGraphSnapshotNode, evidence: GraphEvidenceOptions | undefined): string {
  const line = evidence?.lineByNodeId?.[node.id];
  return `${node.filePath}${line ? `:${line}` : ''}`;
}

function nodeEvidence(node: CodeGraphSnapshotNode, evidence: GraphEvidenceOptions | undefined): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    signature: node.signature,
    line: evidence?.lineByNodeId?.[node.id]
  };
}

function normalizeDiffPath(path: string): string | undefined {
  if (path === '/dev/null') {
    return undefined;
  }
  return path.replace(/^[ab]\//, '');
}

function normalizeSignature(signature: string): string {
  return normalizeSpaces(signature)
    .replace(/^(export\s+)?(default\s+)?(async\s+)?/, '')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .toLowerCase();
}

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeName(value: string): string {
  return value.trim().split('.').at(-1)?.toLowerCase() ?? value.trim().toLowerCase();
}
