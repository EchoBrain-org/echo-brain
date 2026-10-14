#!/usr/bin/env node
// The Linux desktop .deb as dpkg applies it (ADR-0035). The update helper
// installs a signed .deb with apt-get as root, so what dpkg runs or places as
// root must be reviewed source: the maintainer scripts, the AppArmor profile,
// the update helper and the package relationships equal the files in linux/ at
// the bound commit, and nothing lands outside the app's own footprint. Every
// member of both tarballs is read from its headers here, so dpkg sees nothing
// this check did not.
//
// `node scripts/check-deb.mjs PACKAGE.deb` checks a built package against
// HEAD. The update feed's `prepare` runs the same check against the release
// commit, then checks the identity and the embedded Person client.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINUX = 'product/echo-desktop/linux/';
const APP = './opt/ECHO';
// Bound members, keyed by their path in the tarball, with their source path.
// dpkg runs these two as root:
const BOUND_CONTROL = new Map([['./postinst', `${LINUX}postinst`], ['./postrm', `${LINUX}postrm`]]);
// pkexec runs the helper as root, and postinst loads the profile into the kernel:
const BOUND_DATA = new Map([
  [`${APP}/resources/echo-desktop-update-helper`, `${LINUX}echo-desktop-update-helper`],
  [`${APP}/resources/apparmor-profile`, `${LINUX}apparmor-profile`],
]);
// fpm's control file for this configuration. Fields such as Pre-Depends,
// Conflicts, Breaks, Replaces or Provides would let apt change other packages.
const CONTROL_FIELDS = new Set(['package', 'version', 'license', 'vendor', 'architecture', 'maintainer', 'installed-size',
  'depends', 'recommends', 'section', 'priority', 'homepage', 'description']);
const CONTROL_MEMBERS = new Set(['./control', './md5sums', ...BOUND_CONTROL.keys()]);
// Outside /opt/ECHO, electron-builder ships only the desktop entry, the icons
// and fpm's changelog, plus the directories above them.
const ICON_SIZE = String.raw`(?:\d{1,4}x\d{1,4}|scalable)`;
const SYSTEM_DIRECTORY = new RegExp(String.raw`^\.(?:/opt|/usr(?:/share(?:/applications|/doc(?:/echo-desktop)?|/icons(?:/hicolor(?:/${ICON_SIZE}(?:/apps)?)?)?)?)?)?$`);
const SYSTEM_FILE = new RegExp(String.raw`^\./usr/share/(?:applications/org\.echobrain\.echo-desktop\.desktop|icons/hicolor/${ICON_SIZE}/apps/echo-desktop\.(?:png|svg)|doc/echo-desktop/[^/]+)$`);
// Decompressed sizes: the app is about 300 MB.
const CONTROL_LIMIT = 16 * 1024 * 1024;
const DATA_LIMIT = 1024 * 1024 * 1024;
const DECOMPRESS = { xz: ['xz', '--format=xz', '-dc'], gz: ['gzip', '-dc'], zst: ['zstd', '-dc'] };
const BLOCK = 512;

function fail(code) { throw new Error(code); }

// A .deb is an ar archive of exactly three members. fpm writes it with GNU ar,
// whose slash-terminated member names macOS ar cannot extract, so it is read here.
function debMembers(bytes) {
  if (bytes.subarray(0, 8).toString('latin1') !== '!<arch>\n') fail('desktop_package_invalid');
  const members = [];
  for (let offset = 8; offset < bytes.length;) {
    const header = bytes.subarray(offset, offset + 60).toString('latin1');
    const size = header.slice(48, 58).trimEnd();
    const end = offset + 60 + Number(size);
    if (header.length !== 60 || header.slice(58) !== '`\n' || !/^\d+$/.test(size) || end > bytes.length) fail('desktop_package_invalid');
    members.push({ name: header.slice(0, 16).trimEnd().replace(/\/$/, ''), bytes: bytes.subarray(offset + 60, end) });
    offset = end + (end % 2);
  }
  const [binary, control, data] = members;
  if (members.length !== 3 || binary.name !== 'debian-binary' || binary.bytes.toString('latin1') !== '2.0\n' ||
      !/^control\.tar\.(xz|gz|zst)$/.test(control.name) || !/^data\.tar\.(xz|gz|zst)$/.test(data.name)) fail('desktop_package_invalid');
  return { control, data };
}

function decompress(member, limit) {
  const [command, ...args] = DECOMPRESS[member.name.split('.').at(-1)];
  try {
    return execFileSync(command, args, { input: member.bytes, maxBuffer: limit, timeout: 120_000, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return fail('desktop_package_invalid'); }
}

const text = field => { const end = field.indexOf(0); return field.subarray(0, end < 0 ? field.length : end).toString('latin1'); };
function octal(field) {
  const digits = field.toString('latin1').replace(/^ +/, '').replace(/[\0 ]+$/, '');
  if (!/^[0-7]{1,12}$/.test(digits)) fail('desktop_package_invalid');
  return parseInt(digits, 8);
}
const TYPES = { 0: 'file', '\0': 'file', 2: 'symlink', 5: 'directory', 1: 'hard link', 3: 'device', 4: 'device', 6: 'fifo' };

/**
 * Every member of a ustar or GNU tar, in archive order, keyed by its path with
 * any trailing slash removed. GNU long names ('L', 'K') are read as dpkg reads
 * them; anything dpkg might read differently (PAX headers, sparse files) is
 * refused, as are links other than symlinks, special files, special mode bits,
 * group or other write, owners other than root, unsafe paths and a member
 * whose parent is not a directory listed before it.
 */
export function tarMembers(tar) {
  const members = new Map();
  const long = { L: null, K: null };
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.length !== BLOCK) fail('desktop_package_invalid');
    // The end: dpkg stops at the first zero block, so nothing may follow it.
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) fail('desktop_package_invalid');
      break;
    }
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    const magic = header.subarray(257, 265).toString('latin1');
    if (sum !== octal(header.subarray(148, 156)) || !['ustar\x0000', 'ustar  \0'].includes(magic)) fail('desktop_package_invalid');
    const flag = String.fromCharCode(header[156]);
    const size = octal(header.subarray(124, 136));
    const start = offset + BLOCK;
    if (start + size > tar.length) fail('desktop_package_invalid');
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === 'L' || flag === 'K') {
      const value = tar.subarray(start, start + size);
      if (long[flag] !== null || size < 2 || size > 4096 || value.indexOf(0) !== size - 1) fail('desktop_package_invalid');
      long[flag] = value.subarray(0, -1).toString('latin1');
      continue;
    }
    const type = TYPES[flag] ?? fail('desktop_package_invalid');
    if (!['file', 'symlink', 'directory'].includes(type)) fail('desktop_package_unsafe');
    // Only POSIX ustar has a name prefix; GNU tar keeps other fields there.
    const prefix = magic.startsWith('ustar\0') ? text(header.subarray(345, 500)) : '';
    const name = long.L ?? (prefix ? `${prefix}/` : '') + text(header.subarray(0, 100));
    const link = long.K ?? text(header.subarray(157, 257));
    long.L = long.K = null;
    if ((type === 'symlink') !== (link !== '') || (type !== 'file' && size !== 0)) fail('desktop_package_invalid');
    const path = type === 'directory' && name.endsWith('/') ? name.slice(0, -1) : name;
    const parent = path === '.' ? null : posix.dirname(path);
    if (!/^[\x20-\x7e]+$/.test(name + link) || name.includes('\\') ||
        (path === '.' ? type !== 'directory' : !path.startsWith('./') || path.slice(2).split('/').some(segment => ['', '.', '..'].includes(segment))) ||
        members.has(path) || (parent !== null && members.get(parent)?.type !== 'directory')) fail('desktop_package_unsafe');
    const mode = octal(header.subarray(100, 108));
    if (octal(header.subarray(108, 116)) !== 0 || octal(header.subarray(116, 124)) !== 0 ||
        !['', 'root'].includes(text(header.subarray(265, 297))) || !['', 'root'].includes(text(header.subarray(297, 329))) ||
        mode > 0o777 || (type !== 'symlink' && mode & 0o022)) fail('desktop_package_unsafe');
    members.set(path, { type, mode, link, bytes: type === 'file' ? tar.subarray(start, start + size) : null });
  }
  if (long.L !== null || long.K !== null) fail('desktop_package_invalid');
  return members;
}

// A symlink may name only a path inside /opt/ECHO: an absolute one there, or
// a relative one from its own folder. Without '..', resolving either can only
// descend, or follow another such link.
function linkStaysInApp(link) {
  const segments = link.split('/');
  return !segments.includes('..') && (!link.startsWith('/') || link === '/opt/ECHO' || link.startsWith('/opt/ECHO/'));
}
function allowedData(path, member) {
  if (path === APP) return member.type === 'directory';
  if (path.startsWith(`${APP}/`)) return member.type !== 'symlink' || linkStaysInApp(member.link);
  return member.type === 'directory' ? SYSTEM_DIRECTORY.test(path) : member.type === 'file' && SYSTEM_FILE.test(path);
}

/** The binary control file's fields, lowercased; continuation lines stay with their field. */
function controlFields(bytes) {
  const lines = bytes.toString('latin1');
  if (!lines.endsWith('\n') || /[\0-\x08\x0b-\x1f\x7f]/.test(lines)) fail('desktop_package_mismatch');
  const fields = new Map();
  let last = null;
  for (const line of lines.slice(0, -1).split('\n')) {
    if (last !== null && /^[ \t]/.test(line)) { fields.set(last, `${fields.get(last)}\n${line}`); continue; }
    const field = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/.exec(line);
    last = field?.[1].toLowerCase() ?? null;
    if (!field || !CONTROL_FIELDS.has(last) || fields.has(last)) fail('desktop_package_mismatch');
    fields.set(last, field[2].trim());
  }
  return fields;
}
function requireBound(members, bound, committed) {
  for (const [path, source] of bound) {
    if (members.get(path)?.type !== 'file' || !members.get(path).bytes.equals(committed(source))) fail('desktop_root_file_mismatch');
  }
}

/**
 * Checks a desktop .deb against the commit `committed` reads from (a function
 * from repository path to bytes at that commit) and returns its data members,
 * as tarMembers does. Error codes: desktop_package_invalid (malformed),
 * desktop_package_unsafe (a member outside the footprint or not allowed),
 * desktop_package_mismatch (control fields) and desktop_root_file_mismatch.
 */
export function checkDesktopDeb(bytes, committed) {
  const deb = debMembers(bytes);
  const control = tarMembers(decompress(deb.control, CONTROL_LIMIT));
  for (const [path, member] of control) {
    if (path === '.' ? member.type !== 'directory' : !CONTROL_MEMBERS.has(path) || member.type !== 'file') fail('desktop_package_unsafe');
  }
  requireBound(control, BOUND_CONTROL, committed);
  const fields = controlFields(control.get('./control')?.bytes ?? fail('desktop_package_mismatch'));
  const relationships = JSON.parse(committed(`${LINUX}deb-relationships.json`).toString('utf8'));
  const list = values => (Array.isArray(values) && values.length ? values.join(', ') : undefined);
  if (fields.get('package') !== 'echo-desktop' || fields.get('architecture') !== 'amd64' ||
      fields.get('depends') !== list(relationships.depends) || fields.get('recommends') !== list(relationships.recommends)) fail('desktop_package_mismatch');
  const data = tarMembers(decompress(deb.data, DATA_LIMIT));
  for (const [path, member] of data) if (!allowedData(path, member)) fail('desktop_package_unsafe');
  requireBound(data, BOUND_DATA, committed);
  return data;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1) fail('usage: node scripts/check-deb.mjs PACKAGE.deb');
    const repository = resolve(import.meta.dirname, '../../..');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    checkDesktopDeb(readFileSync(args[0]), source => execFileSync('git', ['show', `${head}:${source}`], { cwd: repository, maxBuffer: 1024 * 1024 }));
    process.stdout.write(`${JSON.stringify({ status: 'checked', source_sha: head })}\n`);
  } catch (error) {
    process.stderr.write(`ECHO deb check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
