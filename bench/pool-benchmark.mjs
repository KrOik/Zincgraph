#!/usr/bin/env node
export * from './pool-benchmark-runner.mjs';
import { runPoolBenchmark, parsePoolBenchmarkArgs } from './pool-benchmark-runner.mjs';
import { pathToFileURL } from 'node:url';

async function main() {
  const options = parsePoolBenchmarkArgs(process.argv.slice(2));
  const result = await runPoolBenchmark(options);
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`\n${result.report}`);
  if (!result.summary.accepted) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
