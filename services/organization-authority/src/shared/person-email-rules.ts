/**
 * The one canonical representation for a person email inside the authority.
 *
 * This is deliberately a narrow identity key, not a general RFC email parser:
 * callers persist and compare it exactly, so it must already be lowercase,
 * trimmed, printable ASCII, and contain one non-edge `@` separator.
 */
export function isCanonicalPersonEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 254 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !/^[!-~]+$/.test(value)
  ) {
    return false;
  }
  const separator = value.indexOf("@");
  return (
    separator > 0 &&
    separator === value.lastIndexOf("@") &&
    separator < value.length - 1
  );
}
