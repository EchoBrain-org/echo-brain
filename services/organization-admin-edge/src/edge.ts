import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import type { SecureContext } from 'node:tls';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '@echo-brain/organization-api';
import type { OrganizationAdminEdgeServeConfig } from './config.js';
import {
  organizationAdminEdgeRoute,
  type OrganizationAdminEdgeRoute,
} from './route-policy.js';

export const MAX_ORGANIZATION_ADMIN_EDGE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_ORGANIZATION_ADMIN_EDGE_CONNECTIONS = 256;
export const MAX_ORGANIZATION_ADMIN_EDGE_HEADER_COUNT = 64;

const MAX_HEADER_BYTES = 16 * 1024;
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000;
const HEADER_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const UPSTREAM_ABSOLUTE_DEADLINE_MS = 20_000;
const DOWNSTREAM_ABSOLUTE_DEADLINE_MS = 20_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_REQUESTS_PER_SOCKET = 100;
const HSTS_VALUE = 'max-age=31536000';
const SERVER_AUTH_EXTENDED_KEY_USAGE_OID = '1.3.6.1.5.5.7.3.1';
const CLIENT_AUTH_EXTENDED_KEY_USAGE_OID = '1.3.6.1.5.5.7.3.2';
const ANY_EXTENDED_KEY_USAGE_OID = '2.5.29.37.0';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const EDGE_CONFIG_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': HSTS_VALUE,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

interface RawHeader {
  readonly name: string;
  readonly normalized_name: string;
  readonly value: string;
}

interface ValidatedRequest {
  readonly route: OrganizationAdminEdgeRoute;
  readonly raw_headers: readonly RawHeader[];
  readonly connection_named_headers: ReadonlySet<string>;
}

interface AdminClientIdentity {
  readonly pin: `sha256:${string}`;
  readonly client_id: `cid_${string}`;
}

interface ServerTlsSocket extends TLSSocket {
  readonly servername?: string | false;
}

interface BufferedUpstreamResponse {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly body: Buffer;
}

export interface RunningOrganizationAdminEdge {
  readonly address: AddressInfo;
  active_connection_count(): Promise<number>;
  close(): Promise<void>;
}

export interface OrganizationAdminEdgeStartOptions {
  /**
   * Testable fail-closed override. Production callers omit this value; an
   * override may only shorten, never extend, the built-in deadline.
   */
  readonly upstream_absolute_deadline_ms?: number;
  /**
   * Testable fail-closed override. Production callers omit this value; an
   * override may only shorten, never extend, the built-in deadline.
   */
  readonly downstream_absolute_deadline_ms?: number;
}

export type OrganizationAdminEdgePreflightFailure =
  | 'server_certificate_parse'
  | 'server_certificate_hostname'
  | 'server_certificate_purpose'
  | 'server_certificate_not_yet_valid'
  | 'server_certificate_expired'
  | 'server_private_key_parse'
  | 'server_private_key_mismatch'
  | 'client_ca_or_tls_context';

export interface OrganizationAdminEdgeServePreflightOptions {
  readonly now?: Date;
}

export interface OrganizationAdminEdgeServePreflight {
  readonly listener: {
    readonly host: string;
    readonly port: number;
  };
  readonly public_origin: string;
  readonly employee_authority_base_url: string;
  readonly authority_origin: string;
  readonly allowed_admin_client_count: number;
  readonly checked_at: string;
  readonly server_certificate_not_before: string;
  readonly server_certificate_not_after: string;
  readonly client_ca_certificate_count: number;
}

export class OrganizationAdminEdgePreflightError extends Error {
  constructor(readonly failed_check: OrganizationAdminEdgePreflightFailure) {
    super('organization administrator edge preflight failed');
    this.name = 'OrganizationAdminEdgePreflightError';
  }
}

interface PreparedOrganizationAdminEdgeServeConfig {
  readonly public_origin: URL;
  readonly employee_authority_base_url: URL;
  readonly authority_origin: URL;
  readonly secure_context: SecureContext;
  readonly preflight: OrganizationAdminEdgeServePreflight;
}

class EdgeRequestError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 421 | 502) {
    super('organization administrator edge request rejected');
    this.name = 'EdgeRequestError';
  }
}

function canonicalHttpsOrigin(
  value: string,
  label: string,
  requireDnsName: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be one canonical bare HTTPS origin`);
  }
  if (
    value.length === 0 ||
    value.length > 2048 ||
    value !== url.origin ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.length === 0 ||
    url.hostname.endsWith('.')
  ) {
    throw new Error(`${label} must be one canonical bare HTTPS origin`);
  }
  if (
    requireDnsName &&
    (isIP(url.hostname) !== 0 ||
      url.hostname !== url.hostname.toLowerCase() ||
      url.hostname.length > 253 ||
      !url.hostname
        .split('.')
        .every(
          (part) =>
            part.length > 0 &&
            part.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
        ))
  ) {
    throw new Error(`${label} must use a canonical DNS hostname`);
  }
  return url;
}

function shortenedDeadline(
  value: number | undefined,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive fail-closed deadline`);
  }
  return value;
}

function canonicalAuthorityOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('authority origin must be one bare loopback HTTP origin');
  }
  if (
    value.length === 0 ||
    value.length > 2048 ||
    value !== url.origin ||
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('authority origin must be one bare loopback HTTP origin');
  }
  return url;
}

function assertServeConfig(config: OrganizationAdminEdgeServeConfig): {
  readonly public_origin: URL;
  readonly employee_authority_base_url: URL;
  readonly authority_origin: URL;
  readonly server_certificate: X509Certificate;
} {
  if (
    config === null ||
    typeof config !== 'object' ||
    typeof config.listener?.host !== 'string' ||
    isIP(config.listener.host) === 0 ||
    !Number.isSafeInteger(config.listener.port) ||
    config.listener.port < 0 ||
    config.listener.port > 65_535
  ) {
    throw new Error('organization admin edge listener is invalid');
  }
  if (
    !Buffer.isBuffer(config.tls?.certificate_chain) ||
    config.tls.certificate_chain.length === 0 ||
    !Buffer.isBuffer(config.tls.private_key) ||
    config.tls.private_key.length === 0 ||
    !Buffer.isBuffer(config.tls.client_ca_bundle) ||
    config.tls.client_ca_bundle.length === 0
  ) {
    throw new Error('organization admin edge TLS material is invalid');
  }
  if (
    typeof config.trusted_proxy_token !== 'string' ||
    !/^[\x21-\x7e]{32,4096}$/.test(config.trusted_proxy_token)
  ) {
    throw new Error('organization admin edge proxy token is invalid');
  }
  if (
    !(config.allowed_admin_client_spki_sha256 instanceof Set) ||
    config.allowed_admin_client_spki_sha256.size === 0 ||
    config.allowed_admin_client_spki_sha256.size > 256 ||
    [...config.allowed_admin_client_spki_sha256].some(
      (pin) => !/^sha256:[0-9a-f]{64}$/.test(pin),
    )
  ) {
    throw new Error('organization admin edge client pin set is invalid');
  }
  const publicOrigin = canonicalHttpsOrigin(
    config.public_origin,
    'public origin',
    true,
  );
  const employeeAuthorityBaseUrl = canonicalHttpsOrigin(
    config.employee_authority_base_url,
    'employee authority base URL',
    false,
  );
  const authorityOrigin = canonicalAuthorityOrigin(config.authority_origin);
  if (employeeAuthorityBaseUrl.hostname === publicOrigin.hostname) {
    throw new Error(
      'employee authority base URL hostname must differ from administrator public origin hostname',
    );
  }
  let serverCertificate: X509Certificate;
  try {
    serverCertificate = new X509Certificate(config.tls.certificate_chain);
  } catch {
    throw new OrganizationAdminEdgePreflightError('server_certificate_parse');
  }
  if (
    serverCertificate.ca ||
    !certificatePermitsExtendedKeyUsage(
      serverCertificate,
      SERVER_AUTH_EXTENDED_KEY_USAGE_OID,
    )
  ) {
    throw new OrganizationAdminEdgePreflightError('server_certificate_purpose');
  }
  if (
    serverCertificate.checkHost(publicOrigin.hostname, {
      subject: 'never',
    }) === undefined
  ) {
    throw new OrganizationAdminEdgePreflightError(
      'server_certificate_hostname',
    );
  }
  return {
    public_origin: publicOrigin,
    employee_authority_base_url: employeeAuthorityBaseUrl,
    authority_origin: authorityOrigin,
    server_certificate: serverCertificate,
  };
}

function certificatePermitsExtendedKeyUsage(
  certificate: X509Certificate,
  requiredUsage: string,
): boolean {
  const usages = certificate.keyUsage as readonly string[] | undefined;
  return (
    usages === undefined ||
    usages.includes(requiredUsage) ||
    usages.includes(ANY_EXTENDED_KEY_USAGE_OID)
  );
}

function preflightClock(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('organization admin edge preflight clock is invalid');
  }
  return now;
}

function certificateValidity(
  certificate: X509Certificate,
  now: Date,
  failures: {
    readonly not_yet_valid: OrganizationAdminEdgePreflightFailure;
    readonly expired: OrganizationAdminEdgePreflightFailure;
  },
): {
  readonly not_before: Date;
  readonly not_after: Date;
} {
  const notBefore = certificate.validFromDate;
  const notAfter = certificate.validToDate;
  if (
    !Number.isFinite(notBefore.getTime()) ||
    !Number.isFinite(notAfter.getTime()) ||
    notBefore.getTime() >= notAfter.getTime()
  ) {
    throw new OrganizationAdminEdgePreflightError(failures.expired);
  }
  if (now.getTime() < notBefore.getTime()) {
    throw new OrganizationAdminEdgePreflightError(failures.not_yet_valid);
  }
  if (now.getTime() >= notAfter.getTime()) {
    throw new OrganizationAdminEdgePreflightError(failures.expired);
  }
  return { not_before: notBefore, not_after: notAfter };
}

function clientCaCertificates(bundle: Buffer): readonly X509Certificate[] {
  const text = bundle.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bundle)) {
    throw new OrganizationAdminEdgePreflightError('client_ca_or_tls_context');
  }
  const pattern =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const certificates: X509Certificate[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (
      index === undefined ||
      !/^[\t\n\r ]*$/.test(text.slice(offset, index))
    ) {
      throw new OrganizationAdminEdgePreflightError('client_ca_or_tls_context');
    }
    try {
      certificates.push(new X509Certificate(match[0]));
    } catch {
      throw new OrganizationAdminEdgePreflightError('client_ca_or_tls_context');
    }
    offset = index + match[0].length;
  }
  if (certificates.length === 0 || !/^[\t\n\r ]*$/.test(text.slice(offset))) {
    throw new OrganizationAdminEdgePreflightError('client_ca_or_tls_context');
  }
  return certificates;
}

function prepareOrganizationAdminEdgeServeConfig(
  config: OrganizationAdminEdgeServeConfig,
  options: OrganizationAdminEdgeServePreflightOptions = {},
): PreparedOrganizationAdminEdgeServeConfig {
  const validated = assertServeConfig(config);
  const now = preflightClock(options.now);
  const serverValidity = certificateValidity(
    validated.server_certificate,
    now,
    {
      not_yet_valid: 'server_certificate_not_yet_valid',
      expired: 'server_certificate_expired',
    },
  );
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(config.tls.private_key);
  } catch {
    throw new OrganizationAdminEdgePreflightError('server_private_key_parse');
  }
  let privateKeyMatches = false;
  try {
    privateKeyMatches =
      validated.server_certificate.checkPrivateKey(privateKey);
  } catch {
    privateKeyMatches = false;
  }
  if (!privateKeyMatches) {
    throw new OrganizationAdminEdgePreflightError(
      'server_private_key_mismatch',
    );
  }
  const clientCAs = clientCaCertificates(config.tls.client_ca_bundle);
  for (const certificate of clientCAs) {
    if (
      !certificate.ca ||
      !certificatePermitsExtendedKeyUsage(
        certificate,
        CLIENT_AUTH_EXTENDED_KEY_USAGE_OID,
      )
    ) {
      throw new OrganizationAdminEdgePreflightError('client_ca_or_tls_context');
    }
    certificateValidity(certificate, now, {
      not_yet_valid: 'client_ca_or_tls_context',
      expired: 'client_ca_or_tls_context',
    });
  }
  let secureContext: SecureContext;
  try {
    secureContext = createSecureContext({
      key: config.tls.private_key,
      cert: config.tls.certificate_chain,
      ca: config.tls.client_ca_bundle,
      minVersion: 'TLSv1.3',
    });
  } catch {
    throw new OrganizationAdminEdgePreflightError('client_ca_or_tls_context');
  }
  return {
    public_origin: validated.public_origin,
    employee_authority_base_url: validated.employee_authority_base_url,
    authority_origin: validated.authority_origin,
    secure_context: secureContext,
    preflight: Object.freeze({
      listener: Object.freeze({ ...config.listener }),
      public_origin: validated.public_origin.origin,
      employee_authority_base_url: validated.employee_authority_base_url.origin,
      authority_origin: validated.authority_origin.origin,
      allowed_admin_client_count: config.allowed_admin_client_spki_sha256.size,
      checked_at: now.toISOString(),
      server_certificate_not_before: serverValidity.not_before.toISOString(),
      server_certificate_not_after: serverValidity.not_after.toISOString(),
      client_ca_certificate_count: clientCAs.length,
    }),
  };
}

export function preflightOrganizationAdminEdgeServeConfig(
  config: OrganizationAdminEdgeServeConfig,
  options: OrganizationAdminEdgeServePreflightOptions = {},
): OrganizationAdminEdgeServePreflight {
  return prepareOrganizationAdminEdgeServeConfig(config, options).preflight;
}

export function organizationAdminClientCertificateIdentity(
  certificate: X509Certificate,
): AdminClientIdentity {
  const exported = certificate.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  if (!Buffer.isBuffer(exported)) {
    throw new Error('administrator client public key export failed');
  }
  const digest = createHash('sha256').update(exported).digest();
  return Object.freeze({
    pin: `sha256:${digest.toString('hex')}`,
    client_id: `cid_${digest.toString('base64url')}`,
  });
}

function requestClientIdentity(
  request: IncomingMessage,
  allowedPins: ReadonlySet<string>,
  expectedServername: string,
): AdminClientIdentity {
  const socket = request.socket;
  if (
    !(socket instanceof TLSSocket) ||
    socket.authorized !== true ||
    (socket as ServerTlsSocket).servername !== expectedServername
  ) {
    throw new EdgeRequestError(421);
  }
  const certificate = socket.getPeerX509Certificate();
  if (certificate === undefined) throw new EdgeRequestError(403);
  const identity = organizationAdminClientCertificateIdentity(certificate);
  if (!allowedPins.has(identity.pin)) throw new EdgeRequestError(403);
  return identity;
}

function parseRawHeaders(request: IncomingMessage): readonly RawHeader[] {
  if (
    request.rawHeaders.length === 0 ||
    request.rawHeaders.length % 2 !== 0 ||
    request.rawHeaders.length / 2 >
      MAX_ORGANIZATION_ADMIN_EDGE_HEADER_COUNT
  ) {
    throw new EdgeRequestError(400);
  }
  const headers: RawHeader[] = [];
  const names = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!;
    const value = request.rawHeaders[index + 1]!;
    const normalizedName = name.toLowerCase();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value) ||
      names.has(normalizedName)
    ) {
      throw new EdgeRequestError(400);
    }
    names.add(normalizedName);
    headers.push({ name, normalized_name: normalizedName, value });
  }
  return headers;
}

function header(
  headers: readonly RawHeader[],
  name: string,
): string | undefined {
  return headers.find((candidate) => candidate.normalized_name === name)?.value;
}

function connectionNamedHeaders(
  headers: readonly RawHeader[],
): ReadonlySet<string> {
  const result = new Set<string>();
  const connection = header(headers, 'connection');
  if (connection === undefined) return result;
  for (const part of connection.split(',')) {
    const name = part.trim().toLowerCase();
    if (
      name.length === 0 ||
      !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
    ) {
      throw new EdgeRequestError(400);
    }
    result.add(name);
  }
  return result;
}

function canonicalContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new EdgeRequestError(400);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new EdgeRequestError(400);
  return length;
}

function validateRequest(
  request: IncomingMessage,
  expectedHost: string,
  expectedOrigin: string,
): ValidatedRequest {
  const route = organizationAdminEdgeRoute(request.method, request.url);
  if (route === undefined) throw new EdgeRequestError(404);
  const rawHeaders = parseRawHeaders(request);
  if (header(rawHeaders, 'host') !== expectedHost) {
    throw new EdgeRequestError(421);
  }
  const presentedOrigin = header(rawHeaders, 'origin');
  if (
    (presentedOrigin !== undefined && presentedOrigin !== expectedOrigin) ||
    (route.method === 'POST' && presentedOrigin !== expectedOrigin)
  ) {
    throw new EdgeRequestError(403);
  }
  if (
    header(rawHeaders, 'transfer-encoding') !== undefined ||
    header(rawHeaders, 'expect') !== undefined ||
    header(rawHeaders, 'upgrade') !== undefined ||
    header(rawHeaders, 'content-encoding') !== undefined
  ) {
    throw new EdgeRequestError(400);
  }
  const contentLength = canonicalContentLength(
    header(rawHeaders, 'content-length'),
  );
  if (
    (route.method === 'GET' && contentLength !== undefined) ||
    (route.method === 'POST' &&
      (contentLength === undefined ||
        contentLength <= 0 ||
        contentLength > MAX_ORGANIZATION_API_BODY_BYTES))
  ) {
    throw new EdgeRequestError(
      contentLength !== undefined &&
        contentLength > MAX_ORGANIZATION_API_BODY_BYTES
        ? 413
        : 400,
    );
  }
  return {
    route,
    raw_headers: rawHeaders,
    connection_named_headers: connectionNamedHeaders(rawHeaders),
  };
}

function isEchoHeaderToStrip(name: string): boolean {
  return name.startsWith('x-echo-') && name !== 'x-echo-admin-csrf';
}

function isForwardingHeader(name: string): boolean {
  return (
    name === 'forwarded' ||
    name === 'via' ||
    name === 'x-real-ip' ||
    name.startsWith('x-forwarded-')
  );
}

function proxyRequestHeaders(
  request: ValidatedRequest,
  publicHost: string,
  proxyToken: string,
  clientId: string,
  bodyLength: number,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const input of request.raw_headers) {
    if (
      input.normalized_name === 'host' ||
      input.normalized_name === 'content-length' ||
      HOP_BY_HOP_HEADERS.has(input.normalized_name) ||
      request.connection_named_headers.has(input.normalized_name) ||
      isEchoHeaderToStrip(input.normalized_name) ||
      isForwardingHeader(input.normalized_name)
    ) {
      continue;
    }
    headers[input.normalized_name] = input.value;
  }
  headers.host = publicHost;
  if (request.route.method === 'POST') {
    headers['content-length'] = String(bodyLength);
  }
  headers[TRUSTED_PROXY_AUTHORIZATION_HEADER] =
    `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${proxyToken}`;
  headers[TRUSTED_PROXY_CLIENT_ID_HEADER] = clientId;
  return headers;
}

async function readRequestBody(
  request: IncomingMessage,
  expectedLength: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (
        total > expectedLength ||
        total > MAX_ORGANIZATION_API_BODY_BYTES
      ) {
        throw new EdgeRequestError(413);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof EdgeRequestError) throw error;
    throw new EdgeRequestError(400);
  }
  if (!request.complete || total !== expectedLength) {
    throw new EdgeRequestError(400);
  }
  return Buffer.concat(chunks, total);
}

function responseConnectionNamedHeaders(
  headers: IncomingHttpHeaders,
): ReadonlySet<string> {
  const result = new Set<string>();
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const value of values) {
    for (const part of value.split(',')) {
      const name = part.trim().toLowerCase();
      if (name !== '') result.add(name);
    }
  }
  return result;
}

function normalizedUpstreamHeaders(
  response: IncomingMessage,
  bodyLength: number,
): OutgoingHttpHeaders {
  if (response.rawHeaders.length % 2 !== 0) {
    throw new EdgeRequestError(502);
  }
  const connectionNames = responseConnectionNamedHeaders(response.headers);
  const values = new Map<string, string[]>();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!.toLowerCase();
    const value = response.rawHeaders[index + 1]!;
    const retained = values.get(name) ?? [];
    retained.push(value);
    values.set(name, retained);
  }
  for (const [name, retained] of values) {
    if (retained.length > 1 && name !== 'set-cookie') {
      throw new EdgeRequestError(502);
    }
  }
  const result: OutgoingHttpHeaders = {};
  for (const [name, retained] of values) {
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      connectionNames.has(name) ||
      name === 'strict-transport-security' ||
      name === 'content-length'
    ) {
      continue;
    }
    result[name] = name === 'set-cookie' ? retained : retained[0]!;
  }
  result['content-length'] = String(bodyLength);
  result.connection = 'close';
  result['strict-transport-security'] = HSTS_VALUE;
  return result;
}

async function bufferUpstreamResponse(
  response: IncomingMessage,
): Promise<BufferedUpstreamResponse> {
  if (
    response.headers['transfer-encoding'] !== undefined ||
    response.headers['content-encoding'] !== undefined
  ) {
    response.destroy();
    throw new EdgeRequestError(502);
  }
  const declared = response.headers['content-length'];
  if (Array.isArray(declared)) throw new EdgeRequestError(502);
  let declaredLength: number | undefined;
  if (declared !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) {
      throw new EdgeRequestError(502);
    }
    declaredLength = Number(declared);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > MAX_ORGANIZATION_ADMIN_EDGE_RESPONSE_BYTES
    ) {
      response.destroy();
      throw new EdgeRequestError(502);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_ORGANIZATION_ADMIN_EDGE_RESPONSE_BYTES) {
        response.destroy();
        throw new EdgeRequestError(502);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof EdgeRequestError) throw error;
    throw new EdgeRequestError(502);
  }
  if (
    !response.complete ||
    (declaredLength !== undefined && declaredLength !== total)
  ) {
    throw new EdgeRequestError(502);
  }
  const body = Buffer.concat(chunks, total);
  return {
    status: response.statusCode ?? 502,
    headers: normalizedUpstreamHeaders(response, body.length),
    body,
  };
}

function edgeConfigResponse(
  response: ServerResponse,
  employeeAuthorityBaseUrl: string,
): void {
  const body = Buffer.from(
    JSON.stringify({ authority_base_url: employeeAuthorityBaseUrl }),
    'utf8',
  );
  response.shouldKeepAlive = false;
  response.writeHead(200, {
    ...EDGE_CONFIG_SECURITY_HEADERS,
    Connection: 'close',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  response.end(body);
}

function sendEdgeError(
  response: ServerResponse,
  status: EdgeRequestError['status'],
): void {
  if (response.destroyed || response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(
    JSON.stringify({
      error: {
        code: status === 502 ? 'edge_upstream_unavailable' : 'edge_rejected',
        message:
          status === 502
            ? 'The organization authority is unavailable.'
            : 'The administrator edge rejected the request.',
      },
    }),
    'utf8',
  );
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    ...EDGE_CONFIG_SECURITY_HEADERS,
    Connection: 'close',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  response.end(body);
}

async function proxyToAuthority(input: {
  readonly response: ServerResponse;
  readonly validated: ValidatedRequest;
  readonly body: Buffer;
  readonly authorityOrigin: URL;
  readonly publicHost: string;
  readonly proxyToken: string;
  readonly clientId: string;
  readonly upstreamAbsoluteDeadlineMs: number;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let absoluteDeadline: NodeJS.Timeout | undefined;
    const clearAbsoluteDeadline = (): void => {
      if (absoluteDeadline !== undefined) {
        clearTimeout(absoluteDeadline);
        absoluteDeadline = undefined;
      }
    };
    const finishWithError = (): void => {
      if (settled) return;
      settled = true;
      clearAbsoluteDeadline();
      sendEdgeError(input.response, 502);
      resolve();
    };
    const upstream = httpRequest(
      {
        protocol: 'http:',
        hostname:
          input.authorityOrigin.hostname === '[::1]'
            ? '::1'
            : input.authorityOrigin.hostname,
        port: input.authorityOrigin.port,
        method: input.validated.route.method,
        path: input.validated.route.path,
        headers: proxyRequestHeaders(
          input.validated,
          input.publicHost,
          input.proxyToken,
          input.clientId,
          input.body.length,
        ),
        agent: false,
        maxHeaderSize: MAX_HEADER_BYTES,
      },
      (upstreamResponse) => {
        void bufferUpstreamResponse(upstreamResponse)
          .then((buffered) => {
            if (settled) return;
            try {
              input.response.shouldKeepAlive = false;
              input.response.writeHead(buffered.status, buffered.headers);
              input.response.end(buffered.body);
            } catch {
              finishWithError();
              return;
            }
            settled = true;
            clearAbsoluteDeadline();
            resolve();
          })
          .catch(() => {
            upstreamResponse.destroy();
            finishWithError();
          });
      },
    );
    absoluteDeadline = setTimeout(
      () =>
        upstream.destroy(
          new Error('organization authority absolute deadline exceeded'),
        ),
      input.upstreamAbsoluteDeadlineMs,
    );
    absoluteDeadline.unref?.();
    upstream.once('error', finishWithError);
    upstream.once('upgrade', (upstreamResponse, socket) => {
      upstreamResponse.destroy();
      socket.destroy();
      finishWithError();
    });
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () =>
      upstream.destroy(new Error('organization authority request timed out')),
    );
    input.response.once('close', () => {
      if (!input.response.writableEnded) {
        upstream.destroy(new Error('administrator client disconnected'));
      }
    });
    if (input.validated.route.method === 'POST') upstream.end(input.body);
    else upstream.end();
  });
}

async function closeHttpsServer(
  server: ReturnType<typeof createHttpsServer>,
): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  const deadline = setTimeout(() => {
    server.closeAllConnections();
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  deadline.unref?.();
  try {
    server.close();
    await closed;
  } finally {
    clearTimeout(deadline);
  }
}

export async function startOrganizationAdminEdge(
  config: OrganizationAdminEdgeServeConfig,
  options: OrganizationAdminEdgeStartOptions = {},
): Promise<RunningOrganizationAdminEdge> {
  const prepared = prepareOrganizationAdminEdgeServeConfig(config);
  const upstreamAbsoluteDeadlineMs = shortenedDeadline(
    options.upstream_absolute_deadline_ms,
    UPSTREAM_ABSOLUTE_DEADLINE_MS,
    'upstream absolute deadline',
  );
  const downstreamAbsoluteDeadlineMs = shortenedDeadline(
    options.downstream_absolute_deadline_ms,
    DOWNSTREAM_ABSOLUTE_DEADLINE_MS,
    'downstream absolute deadline',
  );
  const allowedClientPins = new Set(
    config.allowed_admin_client_spki_sha256,
  );
  const trustedProxyToken = config.trusted_proxy_token;
  const server = createHttpsServer(
    {
      key: config.tls.private_key,
      cert: config.tls.certificate_chain,
      ca: config.tls.client_ca_bundle,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      honorCipherOrder: true,
      handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS,
      maxHeaderSize: MAX_HEADER_BYTES,
      SNICallback: (servername, callback) => {
        if (servername !== prepared.public_origin.hostname) {
          callback(new Error('unrecognized TLS server name'));
          return;
        }
        callback(null, prepared.secure_context);
      },
    },
    (request, response) => {
      const downstreamSocket = request.socket;
      const downstreamDeadline = setTimeout(
        () => {
          if (!downstreamSocket.destroyed) downstreamSocket.destroy();
        },
        downstreamAbsoluteDeadlineMs,
      );
      downstreamDeadline.unref?.();
      downstreamSocket.once('close', () => clearTimeout(downstreamDeadline));
      void (async (): Promise<void> => {
        const identity = requestClientIdentity(
          request,
          allowedClientPins,
          prepared.public_origin.hostname,
        );
        const validated = validateRequest(
          request,
          prepared.public_origin.host,
          prepared.public_origin.origin,
        );
        if (validated.route.kind === 'local-config') {
          edgeConfigResponse(
            response,
            prepared.employee_authority_base_url.origin,
          );
          return;
        }
        const declaredLength =
          validated.route.method === 'POST'
            ? canonicalContentLength(
                header(validated.raw_headers, 'content-length'),
              )!
            : 0;
        const body =
          declaredLength === 0
            ? Buffer.alloc(0)
            : await readRequestBody(request, declaredLength);
        await proxyToAuthority({
          response,
          validated,
          body,
          authorityOrigin: prepared.authority_origin,
          publicHost: prepared.public_origin.host,
          proxyToken: trustedProxyToken,
          clientId: identity.client_id,
          upstreamAbsoluteDeadlineMs,
        });
      })().catch((error: unknown) => {
        request.resume();
        sendEdgeError(
          response,
          error instanceof EdgeRequestError ? error.status : 502,
        );
      });
    },
  );
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADER_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
  server.maxConnections = MAX_ORGANIZATION_ADMIN_EDGE_CONNECTIONS;
  server.maxHeadersCount = MAX_ORGANIZATION_ADMIN_EDGE_HEADER_COUNT;
  server.prependListener('secureConnection', (socket) => {
    if (
      (socket as ServerTlsSocket).servername !==
      prepared.public_origin.hostname
    ) {
      socket.destroy();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('tlsClientError', () => {
    // TLS failures are intentionally silent and never include peer material.
  });

  try {
    server.listen({
      host: config.listener.host,
      port: config.listener.port,
    });
    await once(server, 'listening');
  } catch (error) {
    server.closeAllConnections();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.closeAllConnections();
    throw new Error('organization admin edge did not bind a TCP address');
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    address,
    active_connection_count(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.getConnections((error, count) => {
          if (error === null) resolve(count);
          else reject(error);
        });
      });
    },
    close(): Promise<void> {
      closePromise ??= closeHttpsServer(server);
      return closePromise;
    },
  });
}
