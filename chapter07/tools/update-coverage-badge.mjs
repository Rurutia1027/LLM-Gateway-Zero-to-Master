#!/usr/bin/env node
/**
 * Read coverage/coverage-summary.json (from c8) and write shields.io endpoint JSON.
 * Badge URL:
 *   https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<owner>/<repo>/main/examples/07-stream-is-broken/coverage-badge.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const summaryPath = join(root, 'coverage/coverage-summary.json');
const outPath = join(root, 'coverage-badge.json');

const MIN_LINES = Number(process.env.COVERAGE_MIN_LINES ?? 80);

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const pct = Number(summary.total?.lines?.pct ?? 0);
const rounded = Math.round(pct * 10) / 10;

let color = 'red';
if (rounded >= MIN_LINES) color = 'brightgreen';
else if (rounded >= MIN_LINES - 10) color = 'yellow';
else if (rounded >= MIN_LINES - 20) color = 'orange';

const badge = {
  schemaVersion: 1,
  label: 'ch07 coverage',
  message: `${rounded}%`,
  color,
};

writeFileSync(outPath, `${JSON.stringify(badge, null, 2)}\n`);
console.log(`Wrote ${outPath}: ${badge.label} ${badge.message} (${color})`);

if (rounded < MIN_LINES) {
  console.error(`Coverage ${rounded}% is below minimum ${MIN_LINES}%`);
  process.exit(1);
}
