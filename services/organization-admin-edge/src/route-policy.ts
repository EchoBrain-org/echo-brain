import { Buffer } from 'node:buffer';

export const ORGANIZATION_ADMIN_EDGE_CONFIG_PATH = '/admin/edge-config';
export const MAX_ORGANIZATION_ADMIN_EDGE_REQUEST_TARGET_BYTES = 2048;

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const GET_PROXY_PATHS = new Set([
  '/admin',
  '/admin/',
  '/admin/login',
  '/admin/assets/admin.css',
  '/admin/assets/admin.js',
]);

const POST_PROXY_PATHS = new Set([
  '/admin/login',
  '/admin/logout',
  '/admin/memberships',
]);

const POST_PROXY_PATTERNS = Object.freeze([
  new RegExp(
    `^/admin/memberships/mem_${UUID_V4_SOURCE}/enrollment-grants$`,
  ),
  new RegExp(`^/admin/memberships/mem_${UUID_V4_SOURCE}/revocations$`),
  new RegExp(`^/admin/installations/ins_${UUID_V4_SOURCE}/revocations$`),
]);

export type OrganizationAdminEdgeRoute =
  | {
      readonly kind: 'local-config';
      readonly method: 'GET';
      readonly path: typeof ORGANIZATION_ADMIN_EDGE_CONFIG_PATH;
    }
  | {
      readonly kind: 'proxy';
      readonly method: 'GET' | 'POST';
      readonly path: string;
    };

function canonicalPath(requestTarget: string | undefined): string | undefined {
  if (
    typeof requestTarget !== 'string' ||
    requestTarget.length === 0 ||
    Buffer.byteLength(requestTarget, 'utf8') >
      MAX_ORGANIZATION_ADMIN_EDGE_REQUEST_TARGET_BYTES ||
    !requestTarget.startsWith('/') ||
    requestTarget.startsWith('//') ||
    requestTarget.includes('?') ||
    requestTarget.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(requestTarget)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(requestTarget, 'https://organization-admin-edge.invalid');
  } catch {
    return undefined;
  }
  if (
    url.origin !== 'https://organization-admin-edge.invalid' ||
    url.pathname !== requestTarget ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return url.pathname;
}

export function organizationAdminEdgeRoute(
  method: string | undefined,
  requestTarget: string | undefined,
): OrganizationAdminEdgeRoute | undefined {
  const path = canonicalPath(requestTarget);
  if (path === undefined) return undefined;
  if (method === 'GET' && path === ORGANIZATION_ADMIN_EDGE_CONFIG_PATH) {
    return { kind: 'local-config', method: 'GET', path };
  }
  if (method === 'GET' && GET_PROXY_PATHS.has(path)) {
    return { kind: 'proxy', method: 'GET', path };
  }
  if (
    method === 'POST' &&
    (POST_PROXY_PATHS.has(path) ||
      POST_PROXY_PATTERNS.some((pattern) => pattern.test(path)))
  ) {
    return { kind: 'proxy', method: 'POST', path };
  }
  return undefined;
}
