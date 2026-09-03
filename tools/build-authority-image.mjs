#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '..');
const dockerfile = resolve(repo, 'deploy', 'organization-authority', 'Dockerfile');
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function fail(message) {
  throw new Error(`clean-v1 Authority image: ${message}`);
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    fail(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${command} exited ${String(result.status)}`,
    );
  }
  return result.stdout?.trim() ?? '';
}

function sourceSnapshot() {
  const sha = command('git', ['rev-parse', 'HEAD']).toLowerCase();
  if (!SOURCE_SHA.test(sha)) fail('git did not return a full source SHA');
  const dirty = command('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  return { sha, clean: dirty === '' };
}

function buildNumber(value) {
  if (!CANONICAL_POSITIVE_INTEGER.test(value)) {
    fail('build number must be a canonical positive safe integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail('build number must be a canonical positive safe integer');
  }
  return parsed;
}

function main() {
  const [tag, buildNumberFlag, buildNumberValue, ...extra] = process.argv.slice(2);
  if (
    tag === undefined ||
    tag.length === 0 ||
    buildNumberFlag !== '--build-number' ||
    buildNumberValue === undefined ||
    extra.length !== 0
  ) {
    fail(
      'usage: npm run build:authority-image -- <local-image-tag> --build-number <canonical-positive-safe-integer>',
    );
  }
  const parsedBuildNumber = buildNumber(buildNumberValue);

  const before = sourceSnapshot();
  if (!before.clean) fail('build requires clean, committed source');

  command(
    'docker',
    [
      'build',
      '--build-arg',
      `ECHO_SOURCE_SHA=${before.sha}`,
      '--build-arg',
      `ECHO_BUILD_NUMBER=${String(parsedBuildNumber)}`,
      '-f',
      dockerfile,
      '-t',
      tag,
      '.',
    ],
    { stdio: 'inherit' },
  );

  const after = sourceSnapshot();
  if (!after.clean || after.sha !== before.sha) {
    fail('source changed while the image was building');
  }

  const imageSource = command('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    tag,
  ]);
  if (imageSource !== before.sha) {
    fail('built image revision label does not match its committed source');
  }

  const imageBuildNumber = command('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.echobrain.authority.build-number"}}',
    tag,
  ]);
  if (imageBuildNumber !== String(parsedBuildNumber)) {
    fail('built image build-number label does not match its requested build number');
  }

  const telemetryCapability = command('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.echobrain.authority.telemetry.staging-journey-v1"}}',
    tag,
  ]);
  if (telemetryCapability !== 'true') {
    fail('built image does not declare staging journey telemetry V1');
  }

  const environment = command('docker', [
    'image',
    'inspect',
    '--format',
    '{{json .Config.Env}}',
    tag,
  ]);
  let imageEnvironment;
  try {
    imageEnvironment = JSON.parse(environment);
  } catch {
    fail('built image Config.Env is not valid JSON');
  }
  if (!Array.isArray(imageEnvironment)) {
    fail('built image Config.Env is not an array');
  }
  const expectedSourceEnvironment = `ECHO_SOURCE_SHA=${before.sha}`;
  const expectedBuildNumberEnvironment = `ECHO_BUILD_NUMBER=${String(parsedBuildNumber)}`;
  const expectedCapabilityEnvironment = 'ECHO_STAGING_JOURNEY_TELEMETRY_V1=true';
  const capabilityEnvironmentEntries = imageEnvironment.filter(
    (entry) =>
      typeof entry === 'string' &&
      entry.startsWith('ECHO_STAGING_JOURNEY_TELEMETRY_V1='),
  );
  const sourceEnvironmentEntries = imageEnvironment.filter(
    (entry) => typeof entry === 'string' && entry.startsWith('ECHO_SOURCE_SHA='),
  );
  const buildNumberEnvironmentEntries = imageEnvironment.filter(
    (entry) => typeof entry === 'string' && entry.startsWith('ECHO_BUILD_NUMBER='),
  );
  if (
    capabilityEnvironmentEntries.length !== 1 ||
    capabilityEnvironmentEntries[0] !== expectedCapabilityEnvironment ||
    sourceEnvironmentEntries.length !== 1 ||
    sourceEnvironmentEntries[0] !== expectedSourceEnvironment ||
    buildNumberEnvironmentEntries.length !== 1 ||
    buildNumberEnvironmentEntries[0] !== expectedBuildNumberEnvironment
  ) {
    fail(
      'built image Config.Env does not exactly bind telemetry capability, source SHA, and build number',
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      image: tag,
      source_sha: before.sha,
      build_number: parsedBuildNumber,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
