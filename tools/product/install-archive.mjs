#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const TRUSTED_INSTALLER = join(TOOL_DIR, 'install-bundle.mjs');
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ARCHIVE_BASENAME_RE = /^[0-9A-Za-z][0-9A-Za-z._ -]{0,254}$/;

const ZIP = Object.freeze({
  localSignature: 0x04034b50,
  centralSignature: 0x02014b50,
  eocdSignature: 0x06054b50,
  dataDescriptorSignature: 0x08074b50,
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxNameBytes: 1_024,
  maxPathDepth: 64,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeExpectedSha256(value) {
  const normalized =
    typeof value === 'string' && value.startsWith('sha256:')
      ? value.slice('sha256:'.length)
      : value;
  if (!SHA256_RE.test(normalized ?? '')) {
    throw new Error('expected archive SHA-256 is required in lowercase hex');
  }
  return normalized;
}

function pathExists(path) {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function requireSafeArchiveBasename(path) {
  const name = basename(path);
  if (name === '.' || name === '..' || !SAFE_ARCHIVE_BASENAME_RE.test(name)) {
    throw new Error('archive filename is not safe for installation evidence');
  }
  return name;
}

function safeRemoveTemporary(path, parent) {
  const rel = relative(parent, path);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !basename(path).startsWith('echo-brain-archive-')
  ) {
    throw new Error(`refusing to remove unsafe temporary path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

function readSourceArchive(path) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new Error('archive must be a regular file, not a symlink');
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('archive must be a regular file');
    if (opened.size <= 0 || opened.size > ZIP.maxArchiveBytes) {
      throw new Error(
        `archive size must be between 1 and ${String(ZIP.maxArchiveBytes)} bytes`,
      );
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size) {
      throw new Error('archive changed while it was being staged');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function assertRange(bytes, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(`ZIP ${label} is outside the archive`);
  }
}

function parseExtraFields(extra, label) {
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) {
      throw new Error(`ZIP ${label} has a truncated extra field`);
    }
    const identifier = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > extra.length) {
      throw new Error(`ZIP ${label} has a truncated extra field`);
    }
    if (identifier === 0x0001) {
      throw new Error('ZIP64 archives are not supported');
    }
    if (identifier === 0x9901) {
      throw new Error('encrypted ZIP entries are not supported');
    }
    cursor += size;
  }
}

function decodeEntryName(bytes) {
  if (bytes.length === 0 || bytes.length > ZIP.maxNameBytes) {
    throw new Error('ZIP entry name has an unsafe length');
  }
  if (bytes.some((byte) => byte > 0x7f)) {
    throw new Error('ZIP entry names must use the portable ASCII subset');
  }
  let name;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('ZIP entry name is not valid UTF-8');
  }
  if (
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error(`ZIP entry has an unsafe path: ${JSON.stringify(name)}`);
  }
  const directory = name.endsWith('/');
  const pathName = directory ? name.slice(0, -1) : name;
  const parts = pathName.split('/');
  if (
    pathName === '' ||
    parts.length > ZIP.maxPathDepth ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`ZIP entry has an unsafe path: ${JSON.stringify(name)}`);
  }
  return { name, pathName, parts, directory };
}

function classifyEntry(versionMadeBy, externalAttributes, nameIsDirectory) {
  const creator = versionMadeBy >>> 8;
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  const dosVolume = (externalAttributes & 0x08) !== 0;
  if (dosVolume) throw new Error('ZIP volume-label entries are not supported');

  if (creator === 3 || creator === 19) {
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const type = unixMode & 0o170000;
    if (type !== 0o100000 && type !== 0o040000) {
      throw new Error('ZIP contains a symlink or special file');
    }
    const modeIsDirectory = type === 0o040000;
    if (modeIsDirectory !== nameIsDirectory) {
      throw new Error('ZIP entry type does not match its path');
    }
    return modeIsDirectory ? 'directory' : 'file';
  }

  if (dosDirectory !== nameIsDirectory) {
    throw new Error('ZIP entry type does not match its path');
  }
  return nameIsDirectory ? 'directory' : 'file';
}

function findEocd(bytes) {
  const minimum = Math.max(0, bytes.length - (65_535 + 22));
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== ZIP.eocdSignature) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== bytes.length) continue;
    return offset;
  }
  throw new Error('ZIP end-of-central-directory record is missing');
}

function assertSupportedFlags(flags, method, label) {
  if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
    throw new Error(`encrypted ZIP ${label} are not supported`);
  }
  const supported = 0x0002 | 0x0004 | 0x0008 | 0x0800;
  if ((flags & ~supported) !== 0) {
    throw new Error(`ZIP ${label} use unsupported flags`);
  }
  if (method !== 8 && (flags & (0x0002 | 0x0004)) !== 0) {
    throw new Error(`ZIP ${label} use invalid compression flags`);
  }
}

function validatePathGraph(entries) {
  const exactEntries = new Set();
  const foldedNodes = new Map();
  for (const entry of entries) {
    if (exactEntries.has(entry.pathName)) {
      throw new Error(`ZIP contains a duplicate path: ${entry.pathName}`);
    }
    exactEntries.add(entry.pathName);

    for (let depth = 1; depth <= entry.parts.length; depth += 1) {
      const spelling = entry.parts.slice(0, depth).join('/');
      const folded = spelling.toLowerCase();
      const kind =
        depth === entry.parts.length && entry.type === 'file'
          ? 'file'
          : 'directory';
      const existing = foldedNodes.get(folded);
      if (existing !== undefined) {
        if (existing.spelling !== spelling) {
          throw new Error(`ZIP contains a case-colliding path: ${spelling}`);
        }
        if (existing.kind !== kind) {
          throw new Error(`ZIP path is both a file and directory: ${spelling}`);
        }
      } else {
        foldedNodes.set(folded, { spelling, kind });
      }
    }
  }
}

function parseZip(bytes) {
  const eocdOffset = findEocd(bytes);
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('multidisk ZIP archives are not supported');
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (entryCount === 0 || entryCount > ZIP.maxEntries) {
    throw new Error(
      `ZIP entry count exceeds the ${String(ZIP.maxEntries)} entry cap`,
    );
  }
  assertRange(bytes, centralOffset, centralSize, 'central directory');
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error('ZIP central directory does not end at its footer');
  }

  const centralEnd = centralOffset + centralSize;
  const entries = [];
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, cursor, 46, 'central entry');
    if (bytes.readUInt32LE(cursor) !== ZIP.centralSignature) {
      throw new Error('ZIP central directory entry signature is invalid');
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const variableLength = nameLength + extraLength + commentLength;
    assertRange(bytes, cursor + 46, variableLength, 'central entry body');
    if (cursor + 46 + variableLength > centralEnd) {
      throw new Error(
        'ZIP central entry crosses the central directory boundary',
      );
    }
    if (versionNeeded > 20) {
      throw new Error('ZIP entry requires an unsupported extraction version');
    }
    if (method !== 0 && method !== 8) {
      throw new Error('ZIP entry uses an unsupported compression method');
    }
    assertSupportedFlags(flags, method, 'entries');
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error('ZIP64 archives are not supported');
    }
    if (diskStart !== 0 && diskStart !== 0xffff) {
      throw new Error('multidisk ZIP archives are not supported');
    }
    if (diskStart === 0xffff) {
      throw new Error('ZIP64 archives are not supported');
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const extra = bytes.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength,
    );
    parseExtraFields(extra, 'central entry');
    const decoded = decodeEntryName(nameBytes);
    const type = classifyEntry(
      versionMadeBy,
      externalAttributes,
      decoded.directory,
    );
    if (type === 'directory') {
      if (
        compressedSize !== 0 ||
        uncompressedSize !== 0 ||
        expectedCrc32 !== 0
      ) {
        throw new Error('ZIP directory entries must be empty');
      }
    } else {
      if (uncompressedSize > ZIP.maxFileBytes) {
        throw new Error('ZIP entry exceeds the per-file size cap');
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        throw new Error('stored ZIP entry size is inconsistent');
      }
      if (
        uncompressedSize > 1024 * 1024 &&
        (compressedSize === 0 ||
          uncompressedSize > compressedSize * ZIP.maxCompressionRatio)
      ) {
        throw new Error('ZIP entry exceeds the compression-ratio cap');
      }
      totalBytes += uncompressedSize;
      if (totalBytes > ZIP.maxTotalBytes) {
        throw new Error('ZIP exceeds the total uncompressed-size cap');
      }
    }
    entries.push({
      ...decoded,
      type,
      versionNeeded,
      flags,
      method,
      expectedCrc32,
      compressedSize,
      uncompressedSize,
      nameBytes: Buffer.from(nameBytes),
      localOffset,
    });
    cursor += 46 + variableLength;
  }
  if (cursor !== centralEnd) {
    throw new Error('ZIP central-directory entry count is inconsistent');
  }

  validatePathGraph(entries);
  const byOffset = [...entries].sort(
    (left, right) => left.localOffset - right.localOffset,
  );
  if (byOffset[0].localOffset !== 0) {
    throw new Error(
      'ZIP contains an unsupported preamble before its first entry',
    );
  }
  for (let index = 0; index < byOffset.length; index += 1) {
    const entry = byOffset[index];
    const boundary = byOffset[index + 1]?.localOffset ?? centralOffset;
    if (entry.localOffset >= centralOffset || boundary <= entry.localOffset) {
      throw new Error(
        'ZIP local entries overlap or cross the central directory',
      );
    }
    assertRange(bytes, entry.localOffset, 30, 'local entry');
    if (bytes.readUInt32LE(entry.localOffset) !== ZIP.localSignature) {
      throw new Error('ZIP local entry signature is invalid');
    }
    const localVersion = bytes.readUInt16LE(entry.localOffset + 4);
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6);
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8);
    const localCrc32 = bytes.readUInt32LE(entry.localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(entry.localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(entry.localOffset + 22);
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    assertRange(
      bytes,
      entry.localOffset + 30,
      localNameLength + localExtraLength,
      'local entry body',
    );
    const localName = bytes.subarray(
      entry.localOffset + 30,
      entry.localOffset + 30 + localNameLength,
    );
    if (!localName.equals(entry.nameBytes)) {
      throw new Error('ZIP local and central entry names do not match');
    }
    if (
      localVersion !== entry.versionNeeded ||
      localFlags !== entry.flags ||
      localMethod !== entry.method
    ) {
      throw new Error('ZIP local and central entry metadata do not match');
    }
    const localExtra = bytes.subarray(
      entry.localOffset + 30 + localNameLength,
      entry.localOffset + 30 + localNameLength + localExtraLength,
    );
    parseExtraFields(localExtra, 'local entry');
    const usesDescriptor = (entry.flags & 0x0008) !== 0;
    if (usesDescriptor) {
      if (
        ![0, entry.expectedCrc32].includes(localCrc32) ||
        ![0, entry.compressedSize].includes(localCompressedSize) ||
        ![0, entry.uncompressedSize].includes(localUncompressedSize)
      ) {
        throw new Error('ZIP local data-descriptor placeholders are invalid');
      }
    } else if (
      localCrc32 !== entry.expectedCrc32 ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ) {
      throw new Error('ZIP local and central entry sizes do not match');
    }
    const dataOffset =
      entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > boundary) {
      throw new Error('ZIP compressed entry crosses the next record');
    }
    if (usesDescriptor) {
      const descriptorLength = boundary - dataEnd;
      let valuesOffset;
      if (
        descriptorLength === 16 &&
        bytes.readUInt32LE(dataEnd) === ZIP.dataDescriptorSignature
      ) {
        valuesOffset = dataEnd + 4;
      } else if (descriptorLength === 12) {
        valuesOffset = dataEnd;
      } else {
        throw new Error('ZIP data descriptor has an unsupported shape');
      }
      if (
        bytes.readUInt32LE(valuesOffset) !== entry.expectedCrc32 ||
        bytes.readUInt32LE(valuesOffset + 4) !== entry.compressedSize ||
        bytes.readUInt32LE(valuesOffset + 8) !== entry.uncompressedSize
      ) {
        throw new Error('ZIP data descriptor does not match its central entry');
      }
    } else if (dataEnd !== boundary) {
      throw new Error('ZIP contains unrecognized bytes between local entries');
    }
    entry.dataOffset = dataOffset;
  }
  return entries;
}

function extractEntries(bytes, entries, destination) {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of entries) {
    const path = join(destination, ...entry.parts);
    if (entry.type === 'directory') {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const compressed = bytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    );
    let content;
    try {
      content =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              // Node rejects maxOutputLength: 0 even for a valid empty
              // deflate stream. Allow at most one byte in that case; the
              // exact declared size and CRC checks below still require empty
              // output.
              maxOutputLength: Math.max(1, entry.uncompressedSize),
            });
    } catch (error) {
      throw new Error(
        `ZIP entry could not be decompressed: ${entry.name}: ${error.message}`,
      );
    }
    if (
      content.length !== entry.uncompressedSize ||
      crc32(content) !== entry.expectedCrc32
    ) {
      throw new Error(`ZIP entry integrity check failed: ${entry.name}`);
    }
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o600);
  }
}

function locateBundle(extractedRoot) {
  const candidates = [];
  const pending = [extractedRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const artifact = join(current, 'artifact');
    const support = join(current, 'qualification-support');
    if (
      pathExists(artifact) &&
      lstatSync(artifact).isDirectory() &&
      pathExists(support) &&
      lstatSync(support).isDirectory()
    ) {
      candidates.push(current);
      continue;
    }
    // The path graph was validated before extraction; this traversal only
    // considers directories created inside the private extraction root.
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  if (candidates.length === 0) {
    throw new Error('archive does not contain an Echo Brain product bundle');
  }
  if (candidates.length !== 1) {
    throw new Error('archive contains more than one Echo Brain product bundle');
  }
  return candidates[0];
}

function assertBundleTopology(entries, extractedRoot, bundleRoot) {
  const bundlePrefix = relative(extractedRoot, bundleRoot).split(sep).join('/');
  const prefixParts = bundlePrefix === '' ? [] : bundlePrefix.split('/');
  for (const entry of entries) {
    const entryParts = entry.pathName.split('/');
    const isWrapperDirectory =
      entry.type === 'directory' &&
      entryParts.length <= prefixParts.length &&
      entryParts.every((part, index) => part === prefixParts[index]);
    if (isWrapperDirectory) continue;
    if (
      prefixParts.length > 0 &&
      !prefixParts.every((part, index) => entryParts[index] === part)
    ) {
      throw new Error(`archive contains unexpected content: ${entry.pathName}`);
    }
    const relativeParts = entryParts.slice(prefixParts.length);
    const relativePath = relativeParts.join('/');
    const allowed =
      relativePath === 'artifact' ||
      relativePath.startsWith('artifact/') ||
      relativePath === 'qualification-support' ||
      relativePath.startsWith('qualification-support/') ||
      (relativePath === 'draft-report.json' && entry.type === 'file');
    if (!allowed) {
      throw new Error(`archive contains unexpected content: ${entry.pathName}`);
    }
  }
}

function authenticatedArtifactSha256(bundleRoot) {
  const manifestPath = join(bundleRoot, 'artifact', 'artifact-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `authenticated artifact manifest is not valid JSON: ${error.message}`,
    );
  }
  const digest = manifest?.artifact?.sha256;
  if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
    throw new Error(
      'authenticated artifact manifest does not contain a lowercase SHA-256 digest',
    );
  }
  return digest;
}

function defaultRunInstaller({ installerPath, args }) {
  const result = spawnSync(process.execPath, [installerPath, ...args], {
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
    stdio: 'inherit',
  });
  return {
    status: result.status,
    error: result.error,
  };
}

/**
 * Stage and authenticate one external ZIP, extract it under strict limits, and
 * hand the resulting bundle to the trusted installer shipped beside this tool.
 */
export async function installProductArchive(options, dependencies = {}) {
  const expectedArchiveSha256 = normalizeExpectedSha256(
    options.expectedArchiveSha256,
  );
  const archivePath = resolve(options.archivePath);
  const archiveName = requireSafeArchiveBasename(archivePath);
  const installerArgs = [...(options.installerArgs ?? [])];
  if (
    installerArgs.some(
      (argument) =>
        argument === '--bundle-root' ||
        argument.startsWith('--bundle-root=') ||
        argument === '--expected-artifact-sha256' ||
        argument.startsWith('--expected-artifact-sha256=') ||
        argument === '--source-archive-name' ||
        argument.startsWith('--source-archive-name=') ||
        argument === '--source-archive-sha256' ||
        argument.startsWith('--source-archive-sha256='),
    )
  ) {
    throw new Error(
      'archive identity and bundle root are controlled by the archive installer',
    );
  }
  const trustedInstaller = dependencies.installerPath ?? TRUSTED_INSTALLER;
  const installerState = lstatSync(trustedInstaller);
  if (installerState.isSymbolicLink() || !installerState.isFile()) {
    throw new Error('trusted sibling install-bundle.mjs is missing or unsafe');
  }
  const temporaryParent = realpathSync(
    dependencies.temporaryParent ?? tmpdir(),
  );
  const temporary = mkdtempSync(join(temporaryParent, 'echo-brain-archive-'));
  try {
    chmodSync(temporary, 0o700);
    const sourceBytes = readSourceArchive(archivePath);
    const stagedPath = join(temporary, 'download.zip');
    writeFileSync(stagedPath, sourceBytes, { flag: 'wx', mode: 0o600 });
    chmodSync(stagedPath, 0o600);
    const stagedBytes = readFileSync(stagedPath);
    const observedSha256 = sha256(stagedBytes);
    if (observedSha256 !== expectedArchiveSha256) {
      throw new Error(
        'archive SHA-256 does not match the trusted outer digest',
      );
    }
    const entries = parseZip(stagedBytes);
    const extractedRoot = join(temporary, 'extracted');
    extractEntries(stagedBytes, entries, extractedRoot);
    const bundleRoot = locateBundle(extractedRoot);
    assertBundleTopology(entries, extractedRoot, bundleRoot);
    const expectedArtifactSha256 = authenticatedArtifactSha256(bundleRoot);
    const args = [
      '--bundle-root',
      bundleRoot,
      ...installerArgs,
      '--expected-artifact-sha256',
      expectedArtifactSha256,
      '--source-archive-name',
      archiveName,
      '--source-archive-sha256',
      observedSha256,
    ];
    const runInstaller = dependencies.runInstaller ?? defaultRunInstaller;
    const result = await runInstaller({
      installerPath: trustedInstaller,
      bundleRoot,
      args,
      archiveName,
      archiveSha256: observedSha256,
    });
    if (result.status !== 0) {
      throw new Error(
        `trusted bundle installer failed: ${result.error?.message ?? `exit ${String(result.status)}`}`,
      );
    }
    return {
      ok: true,
      archive_name: archiveName,
      archive_sha256: observedSha256,
    };
  } finally {
    safeRemoveTemporary(temporary, temporaryParent);
  }
}

function parseArgs(argv) {
  let archivePath;
  let expectedArchiveSha256;
  const installerArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        [
          'Usage:',
          '  install-archive.mjs --archive PATH --expected-archive-sha256 SHA256',
          '    [install-bundle options]',
          '',
          'Authenticates and safely extracts one external product ZIP before invoking',
          'the trusted sibling install-bundle.mjs.',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
    if (flag === '--archive' || flag === '--expected-archive-sha256') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === '--archive') {
        if (archivePath !== undefined)
          throw new Error('--archive may only be supplied once');
        archivePath = value;
      } else {
        if (expectedArchiveSha256 !== undefined) {
          throw new Error(
            '--expected-archive-sha256 may only be supplied once',
          );
        }
        expectedArchiveSha256 = value;
      }
      continue;
    }
    if (
      flag === '--bundle-root' ||
      flag === '--source-archive-name' ||
      flag === '--source-archive-sha256'
    ) {
      throw new Error(`${flag} is controlled by the archive installer`);
    }
    installerArgs.push(flag);
  }
  if (archivePath === undefined) throw new Error('--archive is required');
  try {
    expectedArchiveSha256 = normalizeExpectedSha256(expectedArchiveSha256);
  } catch {
    throw new Error(
      '--expected-archive-sha256 must be lowercase hex, with optional sha256: prefix',
    );
  }
  return { archivePath, expectedArchiveSha256, installerArgs };
}

async function main() {
  await installProductArchive(parseArgs(process.argv.slice(2)));
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`install-archive: ${error.message}\n`);
    process.exitCode = 1;
  });
}
