import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSanitizedChild } from '../../src/product/spawn-sanitized-child.js';

const COMMAND = resolve('tools/product/install-echo-brain.command');
const TRUSTED_ARCHIVE_INSTALLER = resolve('tools/product/install-archive.mjs');
const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-install-command-test-')),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('founder shell entrypoint', () => {
  it('selects archive mode in any flag order and preserves quoted arguments', async () => {
    const root = temporaryRoot();
    const fakeNode = join(root, 'native node');
    const log = join(root, 'invocation.log');
    writeFileSync(
      fakeNode,
      [
        '#!/bin/sh',
        'if [ "${1:-}" = "-e" ]; then exit 0; fi',
        ': "${ECHO_COMMAND_TEST_LOG:?}"',
        'printf "NODE_OPTIONS=%s\\nNODE_PATH=%s\\n" "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" > "$ECHO_COMMAND_TEST_LOG"',
        'for argument in "$@"; do printf "%s\\n" "$argument"; done >> "$ECHO_COMMAND_TEST_LOG"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(fakeNode, 0o700);
    const archive = join(root, 'downloaded artifact.zip');
    const installRoot = join(root, 'install root');
    const digest = `sha256:${'a'.repeat(64)}`;

    const child = spawnSanitizedChild(
      '/usr/bin/env',
      [
        `ECHO_BRAIN_NODE=${fakeNode}`,
        `ECHO_COMMAND_TEST_LOG=${log}`,
        'NODE_OPTIONS=--require hostile-module',
        'NODE_PATH=/hostile/modules',
        '/bin/sh',
        COMMAND,
        '--install-root',
        installRoot,
        '--archive',
        archive,
        '--expected-archive-sha256',
        digest,
        '--onboard',
      ],
      { cwd: root },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once('error', reject);
      child.once('close', resolveStatus);
    });

    expect(status, stderr).toBe(0);
    expect(readFileSync(log, 'utf8').trimEnd().split('\n')).toEqual([
      'NODE_OPTIONS=unset',
      'NODE_PATH=unset',
      TRUSTED_ARCHIVE_INSTALLER,
      '--install-root',
      installRoot,
      '--archive',
      archive,
      '--expected-archive-sha256',
      digest,
      '--onboard',
    ]);
  });
});
