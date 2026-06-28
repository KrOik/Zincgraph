import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED_FIXTURES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'generated-fixtures.json');
const GENERATED_FIXTURES = JSON.parse(readFileSync(GENERATED_FIXTURES_PATH, 'utf8'));
export const FIXTURES = Object.freeze(GENERATED_FIXTURES);

export function getRepoFixtures(repoId) {
  return FIXTURES[repoId] ?? [];
}

export function getAllRepoFixtures() {
  return Object.entries(FIXTURES).map(([repoId, cases]) => ({ repoId, cases }));
}
