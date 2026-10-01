import type {
  OrganizationSecretReference,
  OrganizationSecretStore,
} from "@echo-brain/organization-control-plane/application/organization-secret-store-contracts";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/organization-control-plane/canonical/canonical-json";

/**
 * One private secret bundles everything a per-organization private Slack app
 * needs: the app identity, the OAuth client, the request-signing secret, and
 * (once the owner completes the Nango connect flow) the Nango connection id
 * that resolves to the bot token. `nango_connection_id` is null while the app
 * is pending its first install.
 */
export const SLACK_APP_CREDENTIALS_KIND_V1 = "echo-slack-app-credentials-v1";

export interface SlackAppCredentialsV1 {
  readonly kind: typeof SLACK_APP_CREDENTIALS_KIND_V1;
  readonly app_id: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly signing_secret: string;
  readonly nango_connection_id: string | null;
}

const APP_ID_PATTERN = /^A[A-Z0-9]{2,63}$/;
const CLIENT_ID_PATTERN = /^[0-9]{1,32}\.[0-9]{1,32}$/;
const NANGO_CONNECTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;
// Bounded, visible, printable ASCII: no whitespace and no control bytes.
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const EXACT_KEYS = Object.freeze(
  ["kind", "app_id", "client_id", "client_secret", "signing_secret", "nango_connection_id"].sort(),
);

function isBoundedVisibleAscii(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    VISIBLE_ASCII_PATTERN.test(value)
  );
}

/** Never includes the candidate's values in its control flow or messages. */
function assertValidSlackAppCredentialsV1(
  value: SlackAppCredentialsV1,
): asserts value is SlackAppCredentialsV1 {
  if (
    value.kind !== SLACK_APP_CREDENTIALS_KIND_V1 ||
    typeof value.app_id !== "string" ||
    !APP_ID_PATTERN.test(value.app_id) ||
    typeof value.client_id !== "string" ||
    !CLIENT_ID_PATTERN.test(value.client_id) ||
    !isBoundedVisibleAscii(value.client_secret, 8, 255) ||
    !isBoundedVisibleAscii(value.signing_secret, 8, 255) ||
    (value.nango_connection_id !== null &&
      (typeof value.nango_connection_id !== "string" ||
        !NANGO_CONNECTION_ID_PATTERN.test(value.nango_connection_id)))
  ) {
    throw new Error("Slack app credentials are invalid");
  }
}

export function serializeSlackAppCredentialsV1(value: SlackAppCredentialsV1): string {
  assertValidSlackAppCredentialsV1(value);
  return canonicalJson(value);
}

/** Exact keys only; throws without ever echoing a candidate value. */
export function parseSlackAppCredentialsV1(secret: string): SlackAppCredentialsV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret) as unknown;
  } catch {
    throw new Error("Slack app credentials are invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== EXACT_KEYS.join(",")
  ) {
    throw new Error("Slack app credentials are invalid");
  }
  const candidate = parsed as SlackAppCredentialsV1;
  assertValidSlackAppCredentialsV1(candidate);
  return Object.freeze({
    kind: candidate.kind,
    app_id: candidate.app_id,
    client_id: candidate.client_id,
    client_secret: candidate.client_secret,
    signing_secret: candidate.signing_secret,
    nango_connection_id: candidate.nango_connection_id,
  });
}

type SlackAppCredentialsLookupStore = Pick<OrganizationSecretStore, "listReferences" | "read">;

export interface FoundSlackAppCredentialsV1 {
  readonly reference: OrganizationSecretReference;
  readonly credentials: SlackAppCredentialsV1;
}

/**
 * Scans every secret reference for the single pending Slack app setup
 * (bundle present, `nango_connection_id` still null). Secrets that are not a
 * Slack app credential bundle — unparseable JSON, or JSON whose `kind` does
 * not match — are silently skipped; they belong to other tools or other
 * secret kinds, including plain legacy bot-token secrets.
 */
export function findPendingSlackAppCredentialsV1(
  store: SlackAppCredentialsLookupStore,
): FoundSlackAppCredentialsV1 | undefined {
  const pending: FoundSlackAppCredentialsV1[] = [];
  for (const reference of store.listReferences()) {
    const raw = store.read(reference);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { kind?: unknown }).kind !== SLACK_APP_CREDENTIALS_KIND_V1
    ) {
      continue;
    }
    const credentials = parseSlackAppCredentialsV1(raw);
    if (credentials.nango_connection_id === null) {
      pending.push({ reference, credentials });
    }
  }
  if (pending.length > 1) {
    throw new Error("more than one pending Slack app setup exists");
  }
  return pending[0];
}

/**
 * Resolves the one secret reference whose canonical digest matches
 * `referenceSha256`, the same rule the Slack bot-token reader uses to pin an
 * opaque reference inside immutable connection state.
 */
export function findSlackAppCredentialsByReferenceSha256V1(
  store: SlackAppCredentialsLookupStore,
  referenceSha256: `sha256:${string}`,
): FoundSlackAppCredentialsV1 {
  const matches = store
    .listReferences()
    .filter((reference) => canonicalSha256(reference) === referenceSha256);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("Slack credential is missing");
  }
  const reference = matches[0];
  return { reference, credentials: parseSlackAppCredentialsV1(store.read(reference)) };
}
