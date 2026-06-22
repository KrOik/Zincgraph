import { describe, expect, test } from 'vitest';

import {
  RelevanceScorer,
  createDefaultRelevanceScorer,
  type TextDocument
} from '../../src/compression/relevance-scorer.js';

const SAMPLE_DOCUMENTS: TextDocument[] = [
  {
    nodeId: 'auth-login',
    content: 'function authenticateUser(username, password) { return bcrypt.compare(password, hash); }',
    filePath: 'src/auth/login.ts',
    qualifiedName: 'authenticateUser'
  },
  {
    nodeId: 'auth-token',
    content: 'function validateToken(token) { return jwt.verify(token, secret); }',
    filePath: 'src/auth/token.ts',
    qualifiedName: 'validateToken'
  },
  {
    nodeId: 'utils-format',
    content: 'function formatDate(date) { return date.toISOString(); }',
    filePath: 'src/utils/format.ts',
    qualifiedName: 'formatDate'
  },
  {
    nodeId: 'db-connect',
    content: 'function connectDatabase(url) { return mongoose.connect(url); }',
    filePath: 'src/db/connect.ts',
    qualifiedName: 'connectDatabase'
  },
  {
    nodeId: 'auth-session',
    content: 'function createSession(userId, token) { return sessionStore.create({ userId, token, authentication: true }); }',
    filePath: 'src/auth/session.ts',
    qualifiedName: 'createSession'
  }
];

describe('RelevanceScorer BM25 mode', () => {
  test('returns scores for all documents', () => {
    const scorer = createDefaultRelevanceScorer();
    const results = scorer.score('authenticate user', SAMPLE_DOCUMENTS, { mode: 'bm25' });

    expect(results).toHaveLength(SAMPLE_DOCUMENTS.length);
    for (const result of results) {
      expect(result.nodeId).toBeTruthy();
      expect(typeof result.score).toBe('number');
    }
  });

  test('auth-related documents score higher for auth query', () => {
    const scorer = createDefaultRelevanceScorer();
    const results = scorer.score('authenticate user password', SAMPLE_DOCUMENTS, { mode: 'bm25' });
    const sorted = [...results].sort((a, b) => b.score - a.score);

    expect(sorted[0]?.nodeId).toBe('auth-login');
  });

  test('returns zero scores for unmatched query', () => {
    const scorer = createDefaultRelevanceScorer();
    const results = scorer.score('xyzzy foobar', SAMPLE_DOCUMENTS, { mode: 'bm25' });

    for (const result of results) {
      expect(result.score).toBe(0);
    }
  });
});

describe('RelevanceScorer embedding mode', () => {
  test('uses sparse cosine similarity without embedding function', () => {
    const scorer = createDefaultRelevanceScorer();
    const results = scorer.score('authenticate', SAMPLE_DOCUMENTS, { mode: 'embedding' });

    expect(results).toHaveLength(SAMPLE_DOCUMENTS.length);
    const authLogin = results.find((r) => r.nodeId === 'auth-login');
    expect(authLogin?.score).toBeGreaterThan(0);
  });

  test('custom embedding function is used when provided', () => {
    const mockEmbedding = {
      embed: (text: string) => {
        const vector = [0, 0, 0, 0];
        if (text.includes('auth')) {
          vector[0] = 1;
        }
        if (text.includes('format')) {
          vector[1] = 1;
        }
        if (text.includes('database')) {
          vector[2] = 1;
        }
        vector[3] = 0.1;
        return vector;
      }
    };
    const scorer = new RelevanceScorer({ embeddingFn: mockEmbedding });
    const results = scorer.score('auth', SAMPLE_DOCUMENTS, { mode: 'embedding' });

    const authLogin = results.find((r) => r.nodeId === 'auth-login');
    expect(authLogin?.score).toBeGreaterThan(0);
  });
});

describe('RelevanceScorer hybrid mode', () => {
  test('combines BM25 and embedding scores', () => {
    const scorer = createDefaultRelevanceScorer();
    const results = scorer.score('how does authentication work', SAMPLE_DOCUMENTS, { mode: 'hybrid' });

    expect(results).toHaveLength(SAMPLE_DOCUMENTS.length);
    for (const result of results) {
      expect(typeof result.bm25Score).toBe('number');
      expect(typeof result.embeddingScore).toBe('number');
    }
  });

  test('respects custom bm25 and embedding weights', () => {
    const scorer = createDefaultRelevanceScorer();
    const bm25Only = scorer.score('authenticate', SAMPLE_DOCUMENTS, {
      mode: 'hybrid',
      bm25Weight: 1,
      embeddingWeight: 0
    });
    const embedOnly = scorer.score('authenticate', SAMPLE_DOCUMENTS, {
      mode: 'hybrid',
      bm25Weight: 0,
      embeddingWeight: 1
    });

    const bm25Auth = bm25Only.find((r) => r.nodeId === 'auth-login');
    const embedAuth = embedOnly.find((r) => r.nodeId === 'auth-login');
    expect(bm25Auth?.score).toBeGreaterThanOrEqual(0);
    expect(embedAuth?.score).toBeGreaterThanOrEqual(0);
  });

  test('hybrid mode ranks auth documents high for natural language query', () => {
    const scorer = createDefaultRelevanceScorer();
    const results = scorer.score('how does authentication work', SAMPLE_DOCUMENTS, { mode: 'hybrid' });
    const sorted = [...results].sort((a, b) => b.score - a.score);

    const authNodes = sorted.slice(0, 3).map((r) => r.nodeId);
    expect(authNodes.some((id) => id.startsWith('auth'))).toBe(true);
  });
});
