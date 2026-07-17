import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function repositoryWorktree(root) {
  const listed = spawnSync(
    '/usr/local/bin/git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'buffer' },
  );
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString('utf8')}`);
  }

  const files = new Map();
  for (const path of listed.stdout.toString('utf8').split('\0')) {
    if (path === '') continue;
    const absolutePath = join(root, path);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    files.set(path, {
      mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
      bytes: readFileSync(absolutePath),
    });
  }
  return files;
}

export function textFile(files, path) {
  return files.get(path)?.bytes.toString('utf8') ?? null;
}

