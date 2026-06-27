export const DEFAULT_CHUNKER_VERSION = 'codegraph-node-v3-semantic-bridge';

export function chunkerCollectionDirectory(chunkerVersion = DEFAULT_CHUNKER_VERSION): string {
  if (chunkerVersion === 'codegraph-node-v1') {
    return 'code-vectors.zvec';
  }
  return `code-vectors-${safeChunkerSegment(chunkerVersion)}.zvec`;
}

function safeChunkerSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'default';
}
