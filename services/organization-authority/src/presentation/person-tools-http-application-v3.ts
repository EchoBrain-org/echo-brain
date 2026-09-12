import { ORGANIZATION_API_PERSON_TOOLS_PATH_V3, validateOrganizationPersonToolsV3, type OrganizationPersonToolV3 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

/** Authenticated aggregation has no provider identity, wire parser or connection store. */
export function createPersonToolsHttpApplicationV3(input: {
  authenticate(token: string): PersonAccessAuthorization;
  tools(token: string): Promise<readonly OrganizationPersonToolV3[]>;
}): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: Object.freeze([{ route_id: 'person-tools-v3', method: 'GET' as const, path: ORGANIZATION_API_PERSON_TOOLS_PATH_V3 }]),
    async accept(request: Parameters<ProviderHttpApplicationV1["accept"]>[0]) {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new AuthorityOperationError('unauthorized', 'person authentication failed');
      const token = header.slice(7);
      const before = input.authenticate(token);
      const tools = await input.tools(token);
      const after = input.authenticate(token);
      if (before.organization_id !== after.organization_id || before.membership_id !== after.membership_id ||
          before.principal_id !== after.principal_id || before.identity_binding_id !== after.identity_binding_id || before.membership_type !== after.membership_type ||
          before.session_family_id !== after.session_family_id || before.person_state_sha256 !== after.person_state_sha256 ||
          before.session_state_sha256 !== after.session_state_sha256) {
        throw new AuthorityOperationError('unauthorized', 'person authentication changed');
      }
      return { status: 200 as const, body: validateOrganizationPersonToolsV3({
        schema_version: 3, kind: 'echo-organization-person-tools',
        organization_id: after.organization_id, membership_id: after.membership_id, tools,
      }) };
    },
  });
}
