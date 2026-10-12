// Byte-deterministic ustar + gzip writer for small allowlisted file sets: every
// member is a regular file with uid/gid 0 and mtime 0, and the gzip header has
// no timestamp, so the same entries always give the same bytes. Callers keep
// their own member names, modes and refusal. authority-staging-invitation-export.mjs
// pins this file's bytes in its receipts (sourceHash).
import { gzipSync } from "node:zlib";

/**
 * @param {readonly { name: string, content: Buffer, mode: number }[]} entries
 * @param {{ owner?: string, invalid: (message: string) => never }} options
 *   `owner` sets the user and group names; `invalid` refuses a header field
 *   that does not fit.
 */
export function deterministicTarGz(entries, { owner, invalid }) {
  function writeString(buffer, offset, length, value) {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > length) invalid(`tar header field is too long: ${value}`);
    bytes.copy(buffer, offset);
  }

  function writeOctal(buffer, offset, length, value) {
    const encoded = value.toString(8).padStart(length - 1, "0");
    if (encoded.length >= length) invalid("tar header numeric field is too large");
    writeString(buffer, offset, length, `${encoded}\0`);
  }

  function tarHeader(name, size, mode) {
    const header = Buffer.alloc(512, 0);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    if (owner !== undefined) {
      writeString(header, 265, 32, owner);
      writeString(header, 297, 32, owner);
    }
    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeOctal(header, 148, 8, checksum);
    return header;
  }

  const chunks = [];
  for (const { name, content, mode } of entries) {
    chunks.push(tarHeader(name, content.length, mode), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding !== 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}
