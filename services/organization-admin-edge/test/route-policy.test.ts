import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ADMIN_EDGE_CONFIG_PATH,
  organizationAdminEdgeRoute,
} from '../src/route-policy.js';

const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000002';

describe('organization administrator edge route policy', () => {
  it('allows exactly the browser console routes with their required methods', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/login',
      '/admin/assets/admin.css',
      '/admin/assets/admin.js',
    ]) {
      expect(organizationAdminEdgeRoute('GET', path)).toEqual({
        kind: 'proxy',
        method: 'GET',
        path,
      });
    }
    expect(
      organizationAdminEdgeRoute('GET', ORGANIZATION_ADMIN_EDGE_CONFIG_PATH),
    ).toEqual({
      kind: 'local-config',
      method: 'GET',
      path: ORGANIZATION_ADMIN_EDGE_CONFIG_PATH,
    });
    for (const path of [
      '/admin/login',
      '/admin/logout',
      '/admin/memberships',
      `/admin/memberships/${MEMBERSHIP_ID}/enrollment-grants`,
      `/admin/memberships/${MEMBERSHIP_ID}/revocations`,
      `/admin/installations/${INSTALLATION_ID}/revocations`,
    ]) {
      expect(organizationAdminEdgeRoute('POST', path)).toEqual({
        kind: 'proxy',
        method: 'POST',
        path,
      });
    }
  });

  it('rejects other methods, APIs, queries, traversal, and malformed identifiers', () => {
    for (const [method, path] of [
      ['HEAD', '/admin'],
      ['OPTIONS', '/admin/login'],
      ['POST', ORGANIZATION_ADMIN_EDGE_CONFIG_PATH],
      ['GET', '/v1/admin/overview'],
      ['GET', '/v1/enrollments'],
      ['GET', '/_echo/runtime-status'],
      ['GET', '/admin?query=value'],
      ['GET', '/admin/../_echo/runtime-status'],
      ['GET', '/admin/%2e%2e/_echo/runtime-status'],
      ['GET', '//admin'],
      [
        'POST',
        '/admin/memberships/mem_00000000-0000-1000-8000-000000000001/revocations',
      ],
      [
        'POST',
        '/admin/installations/ins_00000000-0000-4000-7000-000000000002/revocations',
      ],
    ]) {
      expect(organizationAdminEdgeRoute(method, path)).toBeUndefined();
    }
  });
});
