import type {
  AcceptedOrganizationRecordV1,
  SubmitOrganizationRecordEnvelopeRequestV1,
} from '@echo-brain/organization-api';

/**
 * The one record use case the HTTP listener exposes.
 *
 * It is a separate optional application from
 * `OrganizationAuthorityHttpApplication`, exactly like the integrations
 * application: an authority process composed without the record module simply
 * does not mount the route, and every existing caller of the authority
 * application is unaffected.
 */
export interface OrganizationRecordHttpApplication {
  submitRecordEnvelope(
    request: SubmitOrganizationRecordEnvelopeRequestV1,
  ): Promise<AcceptedOrganizationRecordV1>;
}
