const CANONICAL_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, and a real instant that round-trips unchanged. */
export function isCanonicalUtcMillisTimestampV1(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UTC_MILLIS.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Any string that `Date.parse` reads and `toISOString` reproduces unchanged. */
export function isCanonicalUtcTimestampV1(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
