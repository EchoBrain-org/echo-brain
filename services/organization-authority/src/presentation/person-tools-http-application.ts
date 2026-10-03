import {
  ORGANIZATION_API_PERSON_TOOLS_PATH_V3,
  ORGANIZATION_API_PERSON_TOOLS_PATH_V4,
  organizationPersonToolV3FromV4,
  validateOrganizationPersonToolsV3,
  validateOrganizationPersonToolsV4,
  type OrganizationPersonToolV4,
} from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

interface PersonToolsHttpInput {
  authenticate(token: string): PersonAccessAuthorization;
  tools(token: string): Promise<readonly OrganizationPersonToolV4[]>;
}

/** Authenticated aggregation has no provider identity, wire parser or connection store. */
function createPersonToolsHttpApplication(
  input: PersonToolsHttpInput,
  route: { readonly route_id: string; readonly path: string },
  body: (authorization: PersonAccessAuthorization, tools: readonly OrganizationPersonToolV4[]) => unknown,
): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: Object.freeze([{ route_id: route.route_id, method: 'GET' as const, path: route.path }]),
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
      return { status: 200 as const, body: body(after, tools) };
    },
  });
}

/** V4 tools in, the owner-only organization_setup status stripped for this older contract. */
export function createPersonToolsHttpApplicationV3(input: PersonToolsHttpInput): ProviderHttpApplicationV1 {
  return createPersonToolsHttpApplication(input, { route_id: 'person-tools-v3', path: ORGANIZATION_API_PERSON_TOOLS_PATH_V3 }, (authorization, tools) => validateOrganizationPersonToolsV3({
    schema_version: 3, kind: 'echo-organization-person-tools',
    organization_id: authorization.organization_id, membership_id: authorization.membership_id, tools: tools.map(organizationPersonToolV3FromV4),
  }));
}

export function createPersonToolsHttpApplicationV4(input: PersonToolsHttpInput): ProviderHttpApplicationV1 {
  return createPersonToolsHttpApplication(input, { route_id: 'person-tools-v4', path: ORGANIZATION_API_PERSON_TOOLS_PATH_V4 }, (authorization, tools) => validateOrganizationPersonToolsV4({
    schema_version: 4, kind: 'echo-organization-person-tools',
    organization_id: authorization.organization_id, membership_id: authorization.membership_id, tools,
  }));
}
