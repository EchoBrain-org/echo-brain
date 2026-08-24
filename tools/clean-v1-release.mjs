#!/usr/bin/env node

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const MAX_RELEASE_RECORD_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`clean-v1 release record: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${path} must contain exactly: ${expected.join(', ')}`);
  }
}

function text(value, path, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${path} is invalid`);
  }
  return value;
}

function timestamp(value, path) {
  let parsed;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  ) {
    fail(`${path} must be a UTC second timestamp`);
  }
  parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== `${value.slice(0, -1)}.000Z`
  ) {
    fail(`${path} must be a UTC second timestamp`);
  }
  return value;
}

/** RFC 8785 key ordering is sufficient for this all-primitive release record. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = object(value, '$');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function validateCleanV1Release(value) {
  const record = object(value, '$');
  exactKeys(
    record,
    [
      'authority_image',
      'baseline_compatibility_class',
      'kind',
      'person_client',
      'release_id',
      'released_at',
      'schema_version',
      'source_sha',
    ],
    '$',
  );
  if (!Number.isInteger(record.schema_version) || record.schema_version !== 1) {
    fail('schema_version must equal integer 1');
  }
  if (record.kind !== 'echo-clean-v1-release') fail('kind must be echo-clean-v1-release');
  const releaseId = text(record.release_id, 'release_id', /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/);
  const releasedAt = timestamp(record.released_at, 'released_at');
  if (record.baseline_compatibility_class !== 'clean-v1') {
    fail('baseline_compatibility_class must equal clean-v1');
  }
  const sourceSha = text(record.source_sha, 'source_sha', SOURCE_SHA);

  const authorityImage = object(record.authority_image, 'authority_image');
  exactKeys(authorityImage, ['reference'], 'authority_image');
  const authorityReference = text(authorityImage.reference, 'authority_image.reference', IMAGE);

  const personClient = object(record.person_client, 'person_client');
  exactKeys(personClient, ['artifact_sha256', 'artifact_url', 'package', 'version'], 'person_client');
  if (personClient.package !== '@echo-brain/person-client') {
    fail('person_client.package must equal @echo-brain/person-client');
  }
  const clientVersion = text(personClient.version, 'person_client.version', VERSION);
  const artifactUrl = text(personClient.artifact_url, 'person_client.artifact_url', /^https:\/\/[^\s?#]+(?:[?#][^\s]*)?$/);
  const artifactSha256 = text(personClient.artifact_sha256, 'person_client.artifact_sha256', SHA256);

  return Object.freeze({
    schema_version: 1,
    kind: 'echo-clean-v1-release',
    release_id: releaseId,
    released_at: releasedAt,
    baseline_compatibility_class: 'clean-v1',
    source_sha: sourceSha,
    authority_image: Object.freeze({ reference: authorityReference }),
    person_client: Object.freeze({
      package: '@echo-brain/person-client',
      version: clientVersion,
      artifact_url: artifactUrl,
      artifact_sha256: artifactSha256,
    }),
  });
}

export function readCleanV1Release(path) {
  const absolute = resolve(path);
  const state = lstatSync(absolute);
  if (state.isSymbolicLink() || !state.isFile() || state.size <= 0 || state.size > MAX_RELEASE_RECORD_BYTES) {
    fail('record must be a non-empty regular file no larger than 16 KiB');
  }
  const raw = readFileSync(absolute, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('record is not valid JSON');
  }
  const validated = validateCleanV1Release(parsed);
  if (raw !== `${canonicalJson(validated)}\n`) {
    fail('record bytes are not canonical JSON followed by one newline');
  }
  return validated;
}

function usage() {
  return 'usage: clean-v1-release.mjs <create|validate|field> <record> [output-or-field]';
}

function main(argv) {
  const [command, path, field] = argv;
  if (command !== 'create' && command !== 'validate' && command !== 'field') fail(usage());
  if (typeof path !== 'string' || (command !== 'validate' && typeof field !== 'string')) fail(usage());
  if (command === 'create') {
    let draft;
    try {
      draft = JSON.parse(readFileSync(resolve(path), 'utf8'));
    } catch {
      fail('draft is not valid JSON');
    }
    const record = validateCleanV1Release(draft);
    try {
      writeFileSync(resolve(field), `${canonicalJson(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      fail(`could not create canonical record: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`${resolve(field)}\n`);
    return;
  }
  const record = readCleanV1Release(path);
  if (command === 'validate') {
    process.stdout.write(`${canonicalJson(record)}\n`);
    return;
  }
  const fields = {
    'authority-image': record.authority_image.reference,
    'baseline-class': record.baseline_compatibility_class,
    'release-id': record.release_id,
    'client-url': record.person_client.artifact_url,
    'client-sha256': record.person_client.artifact_sha256,
    'client-version': record.person_client.version,
    'source-sha': record.source_sha,
  };
  if (!Object.hasOwn(fields, field)) fail(usage());
  process.stdout.write(`${fields[field]}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
