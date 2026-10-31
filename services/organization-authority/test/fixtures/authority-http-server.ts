import type { OrganizationAuthorityHttpServerOptions } from '../../src/presentation/organization-authority-http-server.js';

/** A route the test does not exercise. */
const unused = {} as never;

/**
 * The HTTP server's options for a test: what the test passes, and a stand-in for every route the Authority always
 * composes. The tools list stands in as a provider application with no routes, since the server mounts its routes at start.
 */
export function authorityHttpServerOptions(options: Partial<OrganizationAuthorityHttpServerOptions> = {}): OrganizationAuthorityHttpServerOptions {
  return {
    descriptor: unused, sessions: unused, oidc_provider: unused, expected_issuer: 'https://issuer.example',
    person_record_read: unused, person_record_search: unused, person_answer_v3: unused, person_answer_v7: unused,
    person_source_evidence: unused, person_list: unused, person_trigger_runs: unused, person_ask_check: unused,
    person_changes: unused, person_project_activity: unused, project_context: unused, person_documents: unused,
    document_upload_staging: unused, person_employees: unused, person_tools: { routes: [], accept: unused },
    ...options,
  };
}
