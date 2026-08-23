import {
  DEFAULT_GRANOLA_PAGE_SIZE,
  type GranolaListParams,
  type GranolaListResponse,
} from "./granola-api-client.js";

/**
 * The ownership preflight is intentionally unable to fetch a note detail.
 * Keeping this narrower than the source client's full interface prevents a
 * future preflight change from accidentally admitting provider content.
 */
export interface GranolaRecordOwnerObservationClient {
  listNotes(params: GranolaListParams): Promise<GranolaListResponse>;
}

export interface GranolaRecordOwnerObservation {
  provider: "granola";
  relationship: "record_owner";
  subject: { kind: "email"; value: string };
  assurance: "provider_record_owner_observed";
  notes_examined: number;
}

function normalizedOwnerEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    /\s/u.test(normalized)
  ) {
    return null;
  }
  const [local, domain, extra] = normalized.split("@");
  return local !== undefined &&
    local.length > 0 &&
    domain !== undefined &&
    domain.length > 0 &&
    extra === undefined
    ? normalized
    : null;
}

export function isCanonicalGranolaOwnerEmail(
  value: unknown,
): value is string {
  return typeof value === "string" && normalizedOwnerEmail(value) === value;
}

function granolaRecordOwnerEmail(owner: unknown): string | null {
  return (
    typeof owner === "object" && owner !== null && !Array.isArray(owner)
      ? normalizedOwnerEmail((owner as Record<string, unknown>)["email"])
      : null
  );
}

export function granolaRecordOwnerMatches(
  owner: unknown,
  ownerEmail: string,
): boolean {
  return granolaRecordOwnerEmail(owner) === ownerEmail;
}

/**
 * Observe one bounded Granola metadata page and prove only that the provider
 * reports an accessible record owned by the configured email. This does not
 * claim that the API credential itself belongs to that person.
 */
export async function observeGranolaRecordOwner(
  client: GranolaRecordOwnerObservationClient,
  ownerEmail: string,
): Promise<GranolaRecordOwnerObservation> {
  if (!isCanonicalGranolaOwnerEmail(ownerEmail)) {
    throw new TypeError(
      "Granola record-owner observation requires a canonical lowercase email",
    );
  }
  const response = await client.listNotes({
    page_size: DEFAULT_GRANOLA_PAGE_SIZE,
  });
  const notes = response.notes.slice(0, DEFAULT_GRANOLA_PAGE_SIZE);
  const ownerObserved = notes.some((note) =>
    granolaRecordOwnerMatches(note.owner, ownerEmail),
  );
  if (!ownerObserved) {
    throw new Error(
      "Granola did not report an accessible note owned by the configured owner in the bounded observation page",
    );
  }
  return {
    provider: "granola",
    relationship: "record_owner",
    subject: { kind: "email", value: ownerEmail },
    assurance: "provider_record_owner_observed",
    notes_examined: notes.length,
  };
}
