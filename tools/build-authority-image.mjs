#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '..');
const dockerfile = resolve(repo, 'deploy', 'organization-authority', 'Dockerfile');
const SOURCE_SHA = /^[0-9a-f]{40}$/;

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

function main() {
  const [tag, ...extra] = process.argv.slice(2);
  if (tag === undefined || tag.length === 0 || extra.length !== 0) {
    fail('usage: npm run build:authority-image -- <local-image-tag>');
  }

  const before = sourceSnapshot();
  if (!before.clean) fail('build requires clean, committed source');

  command(
    'docker',
    [
      'build',
      '--build-arg',
      `ECHO_SOURCE_SHA=${before.sha}`,
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
  ]).toLowerCase();
  if (imageSource !== before.sha) {
    fail('built image revision label does not match its committed source');
  }

  process.stdout.write(
    `${JSON.stringify({ image: tag, source_sha: before.sha })}\n`,
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
