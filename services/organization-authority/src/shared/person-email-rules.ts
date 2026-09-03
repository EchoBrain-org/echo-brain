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

/**
 * New expected-email artifacts and OIDC chooser hints use a stricter
 * mailbox-shaped subset. Keep this separate from the durable Person identity
 * key above: that key also validates previously stored and provider-observed
 * addresses, whose historical compatibility must not change.
 */
const CANONICAL_PERSON_EMAIL =
  /^[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

function hasBoundedMailboxParts(value: string): boolean {
  const [localPart, domain] = value.split("@");
  return (
    localPart !== undefined &&
    domain !== undefined &&
    localPart.length <= 64 &&
    domain.length <= 253 &&
    domain.split(".").every((label) => label.length <= 63)
  );
}

export function isExpectedPersonEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 254 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !CANONICAL_PERSON_EMAIL.test(value) ||
    !hasBoundedMailboxParts(value)
  ) {
    return false;
  }
  return true;
}
