const CANONICAL_RELEASE_ID_SOURCE =
  "clean-v1-[a-z0-9][a-z0-9-]{2,63}";
const CANONICAL_RELEASE_ID = new RegExp(
  `^${CANONICAL_RELEASE_ID_SOURCE}$`,
);
const CANONICAL_RELEASE_ID_TOKEN = new RegExp(
  `(?<![\\p{ID_Continue}-])${CANONICAL_RELEASE_ID_SOURCE}(?![\\p{ID_Continue}-])`,
  "gu",
);

function canonicalReleaseIds(value: string): readonly string[] {
  return Object.freeze(value.match(CANONICAL_RELEASE_ID_TOKEN) ?? []);
}

export function isCanonicalReleaseId(value: string): boolean {
  return CANONICAL_RELEASE_ID.test(value);
}

/** Repeated IDs are ambiguous even when every occurrence is identical. */
export function extractSingleCanonicalReleaseId(
  value: string,
): string | undefined {
  const matches = canonicalReleaseIds(value);
  return matches.length === 1 ? matches[0] : undefined;
}

export function containsCanonicalReleaseId(
  value: string,
  releaseId: string,
): boolean {
  return (
    isCanonicalReleaseId(releaseId) &&
    canonicalReleaseIds(value).includes(releaseId)
  );
}
