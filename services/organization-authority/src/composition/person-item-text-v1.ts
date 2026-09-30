/**
 * One display line for the person list and open (ADR-0023): NFC, control,
 * format and line-separator characters become spaces, and a line over
 * `maxBytes` is cut at a code point and ends in "…". Undefined when nothing
 * printable remains, so the caller chooses the fallback.
 */
export function boundedTextV1(value: string | undefined | null, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ").trim();
  if (line.length === 0) return undefined;
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  let prefix = "";
  for (const scalar of line) {
    if (Buffer.byteLength(prefix + scalar, "utf8") > maxBytes - 3) break;
    prefix += scalar;
  }
  return `${prefix.trimEnd()}…`;
}
