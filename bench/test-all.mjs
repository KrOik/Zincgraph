#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'test:unit', command: ['npm', 'run', 'test:unit'] },
  { name: 'test:benchmark', command: ['npm', 'run', 'test:benchmark'] }
];

let failed = false;

for (const step of steps) {
  const result = spawnSync(step.command[0], step.command.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if ((result.status ?? 1) !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
