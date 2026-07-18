#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = join(process.cwd(), 'provenance', 'successors');
const names = readdirSync(root)
  .filter((name) => /^\d{4}-[a-z0-9-]+\.v1\.json$/.test(name))
  .sort();
const errors = [];

if (names.length === 0) errors.push('successor provenance chain is empty');

for (const [index, name] of names.entries()) {
  const path = join(root, name);
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${name}: invalid JSON: ${error.message}`);
    continue;
  }
  const expectedNumber = String(index + 1).padStart(4, '0');
  if (!name.startsWith(`${expectedNumber}-`)) {
    errors.push(
      `${name}: expected contiguous successor number ${expectedNumber}`,
    );
  }
  if (
    record.schema_version !== 1 ||
    record.kind !== 'successor_change_record'
  ) {
    errors.push(`${name}: unsupported schema_version or kind`);
  }
  if (index === 0) {
    if (
      record.extraction_baseline?.commit !==
      '41c28171c64710b3ad23392a2606d75cfe8e7b2c'
    ) {
      errors.push(`${name}: first successor must bind the extraction baseline`);
    }
  } else {
    const expectedPredecessor = `provenance/successors/${names[index - 1]}`;
    if (record.predecessor !== expectedPredecessor) {
      errors.push(`${name}: predecessor must be ${expectedPredecessor}`);
    }
    if (typeof record.decision !== 'string' || record.decision.trim() === '') {
      errors.push(`${name}: decision must be nonempty`);
    }
  }
  if (
    record.state?.maturity !== 'DEV' ||
    record.state?.authority !== false ||
    record.state?.installed !== false ||
    record.state?.wedge_executed !== false
  ) {
    errors.push(`${name}: successor state overclaims current product maturity`);
  }
}

const result = {
  ok: errors.length === 0,
  records: names.length,
  tip: names.length === 0 ? null : `provenance/successors/${names.at(-1)}`,
  errors: errors.sort(),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
