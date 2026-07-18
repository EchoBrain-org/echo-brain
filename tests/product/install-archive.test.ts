import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- the shipped archive installer is an executable plain-ESM tool.
import { installProductArchive } from '../../tools/product/install-archive.mjs';

const TRUSTED_INSTALLER = resolve('tools/product/install-bundle.mjs');
const INNER_ARTIFACT_SHA256 = 'c'.repeat(64);
const roots: string[] = [];

interface ZipEntrySpec {
  name: string;
  data?: string | Buffer;
  localName?: string;
  method?: 0 | 8;
  flags?: number;
  unixMode?: number;
  declaredCrc32?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  diskStart?: number;
}

interface ZipOptions {
  diskNumber?: number;
  centralDisk?: number;
  eocdEntryCount?: number;
  eocdEntriesOnDisk?: number;
}

interface InstallerInvocation {
  installerPath: string;
  bundleRoot: string;
  args: string[];
  archiveName: string;
  archiveSha256: string;
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-install-archive-test-')),
  );
  roots.push(root);
  return root;
}

function zipBytes(entries: ZipEntrySpec[], options: ZipOptions = {}): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const spec of entries) {
    const directory = spec.name.endsWith('/');
    const data = Buffer.isBuffer(spec.data)
      ? spec.data
      : Buffer.from(spec.data ?? '', 'utf8');
    const method = spec.method ?? (directory ? 0 : 8);
    const flags = spec.flags ?? 0x0808;
    const compressed = method === 0 ? data : deflateRawSync(data);
    const actualCrc32 = crc32(data);
    const declaredCrc32 = spec.declaredCrc32 ?? actualCrc32;
    const declaredCompressedSize =
      spec.declaredCompressedSize ?? compressed.length;
    const declaredUncompressedSize =
      spec.declaredUncompressedSize ?? data.length;
    const centralName = Buffer.from(spec.name, 'utf8');
    const localName = Buffer.from(spec.localName ?? spec.name, 'utf8');
    const usesDescriptor = (flags & 0x0008) !== 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(usesDescriptor ? 0 : declaredCrc32, 14);
    local.writeUInt32LE(usesDescriptor ? 0 : declaredCompressedSize, 18);
    local.writeUInt32LE(usesDescriptor ? 0 : declaredUncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);

    const descriptor = usesDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (usesDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(declaredCrc32, 4);
      descriptor.writeUInt32LE(declaredCompressedSize, 8);
      descriptor.writeUInt32LE(declaredUncompressedSize, 12);
    }
    localChunks.push(local, localName, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(declaredCrc32, 16);
    central.writeUInt32LE(declaredCompressedSize, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(spec.diskStart ?? 0, 34);
    const unixMode = spec.unixMode ?? (directory ? 0o040755 : 0o100644);
    central.writeUInt32LE(((unixMode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralChunks.push(central, centralName);

    localOffset +=
      local.length + localName.length + compressed.length + descriptor.length;
  }

  const localBytes = Buffer.concat(localChunks);
  const centralBytes = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  const entryCount = options.eocdEntryCount ?? entries.length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(options.centralDisk ?? 0, 6);
  eocd.writeUInt16LE(options.eocdEntriesOnDisk ?? entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function bundleEntries(prefix = ''): ZipEntrySpec[] {
  return [
    {
      name: `${prefix}artifact/artifact-manifest.json`,
      data: `${JSON.stringify({ artifact: { sha256: INNER_ARTIFACT_SHA256 } })}\n`,
    },
    {
      name: `${prefix}qualification-support/support-manifest.json`,
      data: '{"synthetic":true}\n',
    },
    {
      name: `${prefix}qualification-support/install-bundle.mjs`,
      data: 'throw new Error("archive code must not execute");\n',
    },
  ];
}

function writeArchive(
  root: string,
  bytes: Buffer,
  name = 'Echo Brain build.zip',
) {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, digest: sha256(bytes) };
}

async function expectRejectedZip(
  entries: ZipEntrySpec[],
  message: string | RegExp,
  options: ZipOptions = {},
): Promise<void> {
  const root = temporaryRoot();
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const archive = writeArchive(root, zipBytes(entries, options));
  const runInstaller = vi.fn();

  await expect(
    installProductArchive(
      {
        archivePath: archive.path,
        expectedArchiveSha256: archive.digest,
      },
      { temporaryParent: scratch, runInstaller },
    ),
  ).rejects.toThrow(message);
  expect(runInstaller).not.toHaveBeenCalled();
  expect(readdirSync(scratch)).toEqual([]);
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('trusted external archive installer', () => {
  it('stages, authenticates, extracts, and invokes only the trusted sibling installer', async () => {
    const root = temporaryRoot();
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const archive = writeArchive(
      root,
      zipBytes([{ name: 'release/' }, ...bundleEntries('release/')]),
    );
    let observedBundleRoot = '';

    const result = await installProductArchive(
      {
        archivePath: archive.path,
        expectedArchiveSha256: `sha256:${archive.digest}`,
        installerArgs: [
          '--install-root',
          join(root, 'installed product'),
          '--onboard',
        ],
      },
      {
        temporaryParent: scratch,
        runInstaller: (invocation: InstallerInvocation) => {
          observedBundleRoot = invocation.bundleRoot;
          expect(invocation.installerPath).toBe(TRUSTED_INSTALLER);
          expect(
            readFileSync(
              join(invocation.bundleRoot, 'artifact/artifact-manifest.json'),
              'utf8',
            ),
          ).toBe(
            `${JSON.stringify({ artifact: { sha256: INNER_ARTIFACT_SHA256 } })}\n`,
          );
          expect(invocation.args).toEqual([
            '--bundle-root',
            invocation.bundleRoot,
            '--install-root',
            join(root, 'installed product'),
            '--onboard',
            '--expected-artifact-sha256',
            INNER_ARTIFACT_SHA256,
            '--source-archive-name',
            'Echo Brain build.zip',
            '--source-archive-sha256',
            archive.digest,
          ]);
          expect(invocation.archiveName).toBe('Echo Brain build.zip');
          expect(invocation.archiveSha256).toBe(archive.digest);
          return { status: 0 };
        },
      },
    );

    expect(result).toEqual({
      ok: true,
      archive_name: 'Echo Brain build.zip',
      archive_sha256: archive.digest,
    });
    expect(existsSync(observedBundleRoot)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('extracts a valid empty deflated file', async () => {
    const root = temporaryRoot();
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const archive = writeArchive(
      root,
      zipBytes([
        ...bundleEntries(),
        { name: 'artifact/empty.txt', data: '', method: 8 },
      ]),
    );
    const runInstaller = vi.fn((invocation: InstallerInvocation) => {
      expect(
        readFileSync(join(invocation.bundleRoot, 'artifact/empty.txt')),
      ).toEqual(Buffer.alloc(0));
      return { status: 0 };
    });

    await expect(
      installProductArchive(
        {
          archivePath: archive.path,
          expectedArchiveSha256: archive.digest,
        },
        { temporaryParent: scratch, runInstaller },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(runInstaller).toHaveBeenCalledOnce();
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('requires the trusted outer digest and does not extract on mismatch', async () => {
    const root = temporaryRoot();
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const archive = writeArchive(root, zipBytes(bundleEntries()));
    const runInstaller = vi.fn();

    await expect(
      installProductArchive(
        {
          archivePath: archive.path,
          expectedArchiveSha256: '0'.repeat(64),
        },
        { temporaryParent: scratch, runInstaller },
      ),
    ).rejects.toThrow('trusted outer digest');
    expect(runInstaller).not.toHaveBeenCalled();
    expect(readdirSync(scratch)).toEqual([]);

    await expect(
      installProductArchive(
        { archivePath: archive.path },
        { temporaryParent: scratch },
      ),
    ).rejects.toThrow('expected archive SHA-256 is required');
  });

  it('does not let forwarded arguments override authenticated bundle identity', async () => {
    const root = temporaryRoot();
    const archive = writeArchive(root, zipBytes(bundleEntries()));

    await expect(
      installProductArchive({
        archivePath: archive.path,
        expectedArchiveSha256: archive.digest,
        installerArgs: ['--expected-artifact-sha256', '0'.repeat(64)],
      }),
    ).rejects.toThrow('controlled by the archive installer');
  });

  it.each([
    ['../escape', 'traversal'],
    ['/absolute', 'absolute'],
    ['C:/windows', 'drive absolute'],
    ['artifact\\escape', 'backslash'],
    ['./artifact/file', 'dot segment'],
    ['artifact//file', 'empty segment'],
  ])('rejects unsafe entry path %s (%s)', async (name) => {
    await expectRejectedZip([{ name, data: 'bad\n' }], /unsafe path/);
  });

  it('rejects duplicate, case-colliding, and file/child path graphs', async () => {
    await expectRejectedZip(
      [
        { name: 'artifact/file', data: 'one' },
        { name: 'artifact/file', data: 'two' },
      ],
      'duplicate path',
    );
    await expectRejectedZip(
      [
        { name: 'Artifact/one', data: 'one' },
        { name: 'artifact/two', data: 'two' },
      ],
      'case-colliding path',
    );
    await expectRejectedZip(
      [
        { name: 'artifact', data: 'file' },
        { name: 'artifact/child', data: 'child' },
      ],
      'both a file and directory',
    );
  });

  it('rejects symlinks, encryption, multidisk, ZIP64, and excessive entry counts', async () => {
    await expectRejectedZip(
      [{ name: 'link', data: 'target', unixMode: 0o120777 }],
      'symlink or special file',
    );
    await expectRejectedZip(
      [{ name: 'fifo', unixMode: 0o010644 }],
      'symlink or special file',
    );
    await expectRejectedZip(
      [{ name: 'secret', data: 'ciphertext', flags: 0x0809 }],
      'encrypted ZIP',
    );
    await expectRejectedZip(
      [{ name: 'file', data: 'value' }],
      'multidisk ZIP',
      { diskNumber: 1, centralDisk: 1 },
    );
    await expectRejectedZip(
      [
        {
          name: 'huge',
          data: 'value',
          declaredUncompressedSize: 0xffffffff,
        },
      ],
      'ZIP64',
    );
    await expectRejectedZip(
      [{ name: 'file', data: 'value' }],
      'entry count exceeds',
      { eocdEntryCount: 10_001, eocdEntriesOnDisk: 10_001 },
    );
  });

  it('rejects local-central name mismatch, high-ratio payloads, and bad CRC', async () => {
    await expectRejectedZip(
      [
        {
          name: 'artifact/file',
          localName: 'different/file',
          data: 'value',
        },
      ],
      'local and central entry names',
    );
    await expectRejectedZip(
      [{ name: 'bomb', data: Buffer.alloc(2 * 1024 * 1024) }],
      'compression-ratio cap',
    );
    await expectRejectedZip(
      [{ name: 'corrupt', data: 'value', declaredCrc32: 0x12345678 }],
      'integrity check failed',
    );
  });

  it('enforces per-file and aggregate uncompressed-size caps', async () => {
    await expectRejectedZip(
      [
        {
          name: 'oversize',
          data: 'small',
          declaredCompressedSize: 2 * 1024 * 1024,
          declaredUncompressedSize: 256 * 1024 * 1024 + 1,
        },
      ],
      'per-file size cap',
    );
    await expectRejectedZip(
      ['one', 'two', 'three'].map((name) => ({
        name,
        data: 'small',
        declaredCompressedSize: 1024 * 1024,
        declaredUncompressedSize: 180 * 1024 * 1024,
      })),
      'total uncompressed-size cap',
    );
  });

  it('requires exactly one bundle and cleans extraction after installer failure', async () => {
    await expectRejectedZip(
      [
        {
          name: 'not-a-bundle/artifact/artifact-manifest.json',
          data: '{}\n',
        },
      ],
      'does not contain',
    );
    await expectRejectedZip(
      [...bundleEntries('one/'), ...bundleEntries('two/')],
      'more than one',
    );
    await expectRejectedZip(
      [...bundleEntries(), { name: 'unexpected.txt', data: 'extra\n' }],
      'unexpected content',
    );

    const root = temporaryRoot();
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const archive = writeArchive(root, zipBytes(bundleEntries()));
    let extracted = '';
    await expect(
      installProductArchive(
        {
          archivePath: archive.path,
          expectedArchiveSha256: archive.digest,
        },
        {
          temporaryParent: scratch,
          runInstaller: (invocation: InstallerInvocation) => {
            extracted = invocation.bundleRoot;
            return { status: 7 };
          },
        },
      ),
    ).rejects.toThrow('trusted bundle installer failed');
    expect(existsSync(extracted)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
