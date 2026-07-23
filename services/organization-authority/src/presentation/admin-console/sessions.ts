import {
  createHash,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

const SECRET_BYTES = 32;
const MAX_TOKEN_TEXT_BYTES = 256;
const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_PATTERN = /^cid_([A-Za-z0-9_-]{43})$/;

interface StoredAdminConsoleSession {
  readonly client_id: string;
  readonly csrf_sha256: Buffer;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly creation_order: bigint;
}

export interface AdminConsoleSessionSnapshot {
  readonly client_id: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/** Raw secrets are returned once and are never retained by the store. */
export interface CreatedAdminConsoleSession {
  readonly session_cookie_value: string;
  readonly csrf_token: string;
  readonly session: AdminConsoleSessionSnapshot;
}

export type AdminConsoleSessionProof =
  | {
      readonly kind: 'session';
      readonly client_id: string;
      readonly session_cookie_value: string;
    }
  | {
      readonly kind: 'mutation';
      readonly client_id: string;
      readonly session_cookie_value: string;
      readonly csrf_token: string;
    };

export interface RevokeAdminConsoleSessionInput {
  readonly client_id: string;
  readonly session_cookie_value: string;
  readonly csrf_token: string;
}

export interface AdminConsoleSessionStore {
  create(clientId: string): CreatedAdminConsoleSession;
  verify(proof: AdminConsoleSessionProof): AdminConsoleSessionSnapshot | null;
  revoke(input: RevokeAdminConsoleSessionInput): boolean;
}

export interface InMemoryAdminConsoleSessionStoreOptions {
  readonly session_ttl_ms: number;
  readonly maximum_sessions: number;
  readonly now?: () => number;
  readonly random_bytes?: (length: number) => Uint8Array;
}

function secretSha256(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function isCanonicalOpaqueToken(value: unknown): value is string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === SECRET_BYTES && bytes.toString('base64url') === value;
}

function isCanonicalClientIdentity(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CLIENT_ID_PATTERN.exec(value);
  if (match === null) return false;
  const bytes = Buffer.from(match[1]!, 'base64url');
  return (
    bytes.length === SECRET_BYTES && bytes.toString('base64url') === match[1]
  );
}

function csrfMatches(expectedDigest: Buffer, presented: unknown): boolean {
  const canonical = isCanonicalOpaqueToken(presented);
  const bounded =
    typeof presented === 'string' &&
    Buffer.byteLength(presented, 'utf8') <= MAX_TOKEN_TEXT_BYTES
      ? presented
      : 'invalid-admin-console-csrf-token';
  const actualDigest = secretSha256(bounded);
  const equal = timingSafeEqual(expectedDigest, actualDigest);
  return canonical && equal;
}

function snapshot(
  session: StoredAdminConsoleSession,
): AdminConsoleSessionSnapshot {
  return Object.freeze({
    client_id: session.client_id,
    created_at: new Date(session.created_at_ms).toISOString(),
    expires_at: new Date(session.expires_at_ms).toISOString(),
  });
}

/**
 * Process-local browser administrator console sessions.
 *
 * The map retains only the session-cookie SHA-256 digest and CSRF SHA-256
 * digest. Restarting the authority naturally invalidates every session.
 */
export class InMemoryAdminConsoleSessionStore implements AdminConsoleSessionStore {
  private readonly sessions = new Map<string, StoredAdminConsoleSession>();
  private readonly sessionTtlMs: number;
  private readonly maximumSessions: number;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private nextCreationOrder = 0n;

  constructor(options: InMemoryAdminConsoleSessionStoreOptions) {
    if (
      !Number.isSafeInteger(options.session_ttl_ms) ||
      options.session_ttl_ms <= 0 ||
      options.session_ttl_ms > MAXIMUM_DATE_MILLISECONDS
    ) {
      throw new Error('admin console session TTL must be a positive integer');
    }
    if (
      !Number.isSafeInteger(options.maximum_sessions) ||
      options.maximum_sessions <= 0
    ) {
      throw new Error(
        'admin console maximum sessions must be a positive integer',
      );
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new Error('admin console session clock must be a function');
    }
    if (
      options.random_bytes !== undefined &&
      typeof options.random_bytes !== 'function'
    ) {
      throw new Error('admin console session randomness must be a function');
    }
    this.sessionTtlMs = options.session_ttl_ms;
    this.maximumSessions = options.maximum_sessions;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.random_bytes ?? cryptoRandomBytes;
  }

  private currentTime(): number {
    const now = this.now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > MAXIMUM_DATE_MILLISECONDS
    ) {
      throw new Error(
        'admin console session clock must return valid epoch milliseconds',
      );
    }
    return now;
  }

  private opaqueToken(): string {
    const generated = this.randomBytes(SECRET_BYTES);
    if (
      !(generated instanceof Uint8Array) ||
      generated.byteLength !== SECRET_BYTES
    ) {
      throw new Error(
        'admin console session randomness must return exactly 32 bytes',
      );
    }
    return Buffer.from(generated).toString('base64url');
  }

  private purgeExpired(now: number): void {
    for (const [cookieDigest, session] of this.sessions) {
      if (now >= session.expires_at_ms) this.sessions.delete(cookieDigest);
    }
  }

  private evictOldestExpiring(): void {
    let candidate: readonly [string, StoredAdminConsoleSession] | undefined;
    for (const entry of this.sessions) {
      if (
        candidate === undefined ||
        entry[1].expires_at_ms < candidate[1].expires_at_ms ||
        (entry[1].expires_at_ms === candidate[1].expires_at_ms &&
          entry[1].creation_order < candidate[1].creation_order)
      ) {
        candidate = entry;
      }
    }
    if (candidate !== undefined) this.sessions.delete(candidate[0]);
  }

  private retainedSession(
    sessionCookieValue: unknown,
    clientId: unknown,
    now: number,
  ): StoredAdminConsoleSession | null {
    this.purgeExpired(now);
    if (
      !isCanonicalOpaqueToken(sessionCookieValue) ||
      !isCanonicalClientIdentity(clientId)
    ) {
      return null;
    }
    const session = this.sessions.get(
      secretSha256(sessionCookieValue).toString('hex'),
    );
    if (session === undefined || session.client_id !== clientId) return null;
    return session;
  }

  create(clientId: string): CreatedAdminConsoleSession {
    if (!isCanonicalClientIdentity(clientId)) {
      throw new Error('admin console client identity is not canonical');
    }
    const now = this.currentTime();
    if (this.sessionTtlMs > MAXIMUM_DATE_MILLISECONDS - now) {
      throw new Error(
        'admin console session expiry is outside timestamp range',
      );
    }
    this.purgeExpired(now);

    let sessionCookieValue: string | undefined;
    let csrfToken: string | undefined;
    let cookieDigest: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidateCookie = this.opaqueToken();
      const candidateCsrf = this.opaqueToken();
      const candidateDigest = secretSha256(candidateCookie).toString('hex');
      if (
        candidateCookie !== candidateCsrf &&
        !this.sessions.has(candidateDigest)
      ) {
        sessionCookieValue = candidateCookie;
        csrfToken = candidateCsrf;
        cookieDigest = candidateDigest;
        break;
      }
    }
    if (
      sessionCookieValue === undefined ||
      csrfToken === undefined ||
      cookieDigest === undefined
    ) {
      throw new Error('admin console session secrets could not be generated');
    }

    if (this.sessions.size >= this.maximumSessions) {
      this.evictOldestExpiring();
    }
    const session: StoredAdminConsoleSession = {
      client_id: clientId,
      csrf_sha256: secretSha256(csrfToken),
      created_at_ms: now,
      expires_at_ms: now + this.sessionTtlMs,
      creation_order: this.nextCreationOrder,
    };
    this.nextCreationOrder += 1n;
    this.sessions.set(cookieDigest, session);
    return Object.freeze({
      session_cookie_value: sessionCookieValue,
      csrf_token: csrfToken,
      session: snapshot(session),
    });
  }

  verify(proof: AdminConsoleSessionProof): AdminConsoleSessionSnapshot | null {
    const session = this.retainedSession(
      proof?.session_cookie_value,
      proof?.client_id,
      this.currentTime(),
    );
    if (session === null) return null;
    if (proof.kind === 'mutation') {
      if (!csrfMatches(session.csrf_sha256, proof.csrf_token)) return null;
    } else if (proof.kind !== 'session') {
      return null;
    }
    return snapshot(session);
  }

  revoke(input: RevokeAdminConsoleSessionInput): boolean {
    const now = this.currentTime();
    const session = this.retainedSession(
      input?.session_cookie_value,
      input?.client_id,
      now,
    );
    if (
      session === null ||
      !csrfMatches(session.csrf_sha256, input?.csrf_token)
    ) {
      return false;
    }
    return this.sessions.delete(
      secretSha256(input.session_cookie_value).toString('hex'),
    );
  }
}
