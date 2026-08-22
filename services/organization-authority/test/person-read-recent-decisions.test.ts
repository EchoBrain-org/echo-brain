import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { canonicalSha256, federationId } from '@echo-brain/federation-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import {
  createPersonReadRecentDecisionsApplication,
} from '../src/application/person-read-recent-decisions.js';
import { PersonReadUnauthorizedError } from '../src/application/person-identity-sessions.js';
import type {
  PersonAccessAuthorization,
  PersonReadAuthorizationPort,
  PersonReadFinalDecision,
} from '../src/application/person-identity-sessions.js';
import type {
  AuthorityWriteTransaction,
  PersonReadDecisionAuditEntry,
} from '../src/application/ports/authority-repository.js';
import {
  prepareAllowedRecentDecisionsResponse,
  OrganizationRecentDecisionsError,
  type OrganizationRecentDecisionsProjectedRecord,
  type OrganizationRecentDecisionsPilotActivation,
} from '../src/application/recent-decisions.js';
import { prepareReviewerRecentDecisionsResponse } from '../src/application/reviewer-recent-decisions.js';

const descriptor: Pick<
  OrganizationAuthorityDescriptorV1,
  'authority_id' | 'organization_id'
> = {
  authority_id: federationId('oau'),
  organization_id: federationId('org'),
};
const principalId = federationId('prn');
const pilotMembershipId = federationId('mem');
const otherMembershipId = federationId('mem');
const digest = (value: string) => canonicalSha256({ value });

function authorization(
  membership_id = pilotMembershipId,
): PersonAccessAuthorization {
  return {
    organization_id: descriptor.organization_id,
    principal_id: principalId,
    membership_id,
    membership_type: 'employee',
    identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
    session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_credential_sha256: digest('access'),
    access_expires_at: '2026-08-18T01:00:00.000Z',
    hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
    person_state_sha256: digest('person'),
    session_state_sha256: digest('session'),
    checked_at: '2026-08-18T00:00:00.000Z',
  };
}

function recentRequest() {
  return {
    schema_version: 2,
    kind: 'echo-organization-person-recent-decisions-request',
    request_id: 'rdr_00000000-0000-4000-8000-000000000001',
    authority_id: descriptor.authority_id,
    organization_id: descriptor.organization_id,
    subject_principal_id: principalId,
    http_method: 'POST',
    http_path: '/v2/recent-decisions',
  } as const;
}

function reviewerRequest() {
  return {
    subject_principal_id: principalId,
  } as const;
}

const records: readonly OrganizationRecentDecisionsProjectedRecord[] = [
  {
    log_position: 1,
    record_hash: digest('record'),
    atoms: [
      {
        atom_id: digest('atom'),
        record_hash: digest('record'),
        kind: 'decision',
        text: 'Adopt usage-based pricing.',
      },
    ],
  },
];

function createPort(input: {
  readonly admission?: PersonAccessAuthorization;
  readonly start?: 'inactive' | 'mismatch';
  readonly final?: PersonReadFinalDecision;
}) {
  const audits: PersonReadDecisionAuditEntry[] = [];
  const transaction = {
    appendPersonReadDecisionAudit(entry: PersonReadDecisionAuditEntry) {
      audits.push(entry);
      return {};
    },
  } as unknown as AuthorityWriteTransaction;
  const port: PersonReadAuthorizationPort = {
    admitSelfRead(request) {
      if (input.start === 'inactive') {
        request.commitStartDeny(
          {
            decision: 'deny',
            reason_code: 'person_or_session_inactive',
            authorization: null,
            checked_at: '2026-08-18T00:00:00.000Z',
          },
          transaction,
        );
        throw new PersonReadUnauthorizedError();
      }
      if (input.start === 'mismatch') {
        request.commitStartDeny(
          {
            decision: 'deny',
            reason_code: 'caller_subject_mismatch',
            authorization: authorization(),
            checked_at: '2026-08-18T00:00:00.000Z',
          },
          transaction,
        );
        throw new PersonReadUnauthorizedError();
      }
      return input.admission ?? authorization();
    },
    finalizeSelfRead(request) {
      const decision =
        input.final ??
        ({ decision: 'allow', authorization: request.admission } as const);
      return request.commit(decision, transaction);
    },
  };
  return { port, audits };
}

function activation(): OrganizationRecentDecisionsPilotActivation {
  return {
    organization_id: descriptor.organization_id,
    policy_id: 'pilot-member-readable-v1',
    marker_sha256: digest('marker'),
    audience_notice_sha256: digest('notice'),
    membership_ids: [pilotMembershipId, otherMembershipId].sort() as [
      string,
      string,
    ],
  };
}

function application(
  port: PersonReadAuthorizationPort,
  source = () => records,
  recentActivation = activation(),
  reviewerSource = () => ({
    items: [
      {
        kind: 'decision' as const,
        text: 'Reviewer-only decision.',
        atom_id: digest('reviewer atom'),
        record_hash: digest('reviewer record'),
      },
    ],
  }),
) {
  return createPersonReadRecentDecisionsApplication({
    descriptor,
    authorization: port,
    recent_decisions: {
      activation: recentActivation,
      source: { load: source },
    },
    reviewer_recent_decisions: {
      load: reviewerSource,
    },
  });
}

describe('Person recent-decision V2 reads', () => {
  it('fails before authorization or source access for invalid or misbound V1 activation', () => {
    for (const invalid of [
      { ...activation(), membership_ids: [pilotMembershipId, pilotMembershipId] },
      { ...activation(), organization_id: federationId('org') },
    ]) {
      let admitCalls = 0;
      let sourceCalls = 0;
      const { port } = createPort({});
      const observedPort: PersonReadAuthorizationPort = {
        ...port,
        admitSelfRead(input) {
          admitCalls += 1;
          return port.admitSelfRead(input);
        },
      };
      expect(() =>
        application(
          observedPort,
          () => {
            sourceCalls += 1;
            return records;
          },
          invalid as OrganizationRecentDecisionsPilotActivation,
        ).recentDecisions({ request: recentRequest(), access_token: 'valid' }),
      ).toThrow(
        expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
          code: 'unavailable',
        }),
      );
      expect(admitCalls).toBe(0);
      expect(sourceCalls).toBe(0);
    }
  });

  it('audits caller mismatch and opens no recent source', () => {
    const { port, audits } = createPort({ start: 'mismatch' });
    let sourceCalls = 0;
    const response = application(port, () => {
      sourceCalls += 1;
      return records;
    }).recentDecisions({ request: recentRequest(), access_token: 'bad' });

    expect(response.status_code).toBe(401);
    expect(sourceCalls).toBe(0);
    expect(audits).toMatchObject([
      { decision: 'deny', reason_code: 'caller_subject_mismatch' },
    ]);
  });

  it('audits reviewer caller mismatch before opening its source', () => {
    const { port, audits } = createPort({ start: 'mismatch' });
    let sourceCalls = 0;
    const response = application(port, () => records, activation(), () => {
      sourceCalls += 1;
      return { items: [] };
    }).reviewerRecentDecisions({
      request: reviewerRequest(),
      access_token: 'bad',
    });

    expect(response.status_code).toBe(401);
    expect(sourceCalls).toBe(0);
    expect(audits).toMatchObject([
      { decision: 'deny', reason_code: 'caller_subject_mismatch' },
    ]);
  });

  it('propagates start-audit failure without source access', () => {
    let sourceCalls = 0;
    const brokenTransaction = {
      appendPersonReadDecisionAudit() {
        throw new Error('audit unavailable');
      },
    } as unknown as AuthorityWriteTransaction;
    const port: PersonReadAuthorizationPort = {
      admitSelfRead(input) {
        input.commitStartDeny(
          {
            decision: 'deny',
            reason_code: 'person_or_session_inactive',
            authorization: null,
            checked_at: '2026-08-18T00:00:00.000Z',
          },
          brokenTransaction,
        );
        throw new PersonReadUnauthorizedError();
      },
      finalizeSelfRead: () => {
        throw new Error('unexpected finalization');
      },
    };
    expect(() =>
      application(port, () => {
        sourceCalls += 1;
        return records;
      }).recentDecisions({ request: recentRequest(), access_token: 'valid' }),
    ).toThrow('audit unavailable');
    expect(sourceCalls).toBe(0);
  });

  it('does not classify an unfinalizable admission as an audited denial', () => {
    const port: PersonReadAuthorizationPort = {
      admitSelfRead: () => authorization(),
      finalizeSelfRead: () => {
        throw new Error('Person read admission is invalid or already finalized');
      },
    };
    expect(() =>
      application(port).recentDecisions({
        request: recentRequest(),
        access_token: 'valid',
      }),
    ).toThrow('Person read admission is invalid or already finalized');
  });

  it('audits an active non-pilot Person as fixed V1 404 before source access', () => {
    const { port, audits } = createPort({ admission: authorization(federationId('mem')) });
    let sourceCalls = 0;
    const response = application(port, () => {
      sourceCalls += 1;
      return records;
    }).recentDecisions({ request: recentRequest(), access_token: 'valid' });

    expect(response.status_code).toBe(404);
    expect(sourceCalls).toBe(0);
    expect(audits).toMatchObject([
      { decision: 'deny', reason_code: 'operation_not_permitted' },
    ]);
  });

  it('returns exactly the existing V1 recent and reviewer response bytes', () => {
    const recent = createPort({});
    expect(
      application(recent.port).recentDecisions({
        request: recentRequest(),
        access_token: 'valid',
      }).body,
    ).toEqual(prepareAllowedRecentDecisionsResponse(records).body);

    const reviewer = createPort({});
    const response = application(reviewer.port).reviewerRecentDecisions({
      request: reviewerRequest(),
      access_token: 'valid',
    });
    expect(response.body).toEqual(
      prepareReviewerRecentDecisionsResponse([
        {
          kind: 'decision',
          text: 'Reviewer-only decision.',
          atom_id: digest('reviewer atom'),
          record_hash: digest('reviewer record'),
        },
      ]).body,
    );
  });

  it('keeps reviewer reads available when the recent-decisions pilot is absent', () => {
    const recent = createPort({});
    const withoutPilot = createPersonReadRecentDecisionsApplication({
      descriptor,
      authorization: recent.port,
      reviewer_recent_decisions: {
        load: () => ({
          items: [
            {
              kind: 'decision',
              text: 'Reviewer-only decision.',
              atom_id: digest('reviewer atom'),
              record_hash: digest('reviewer record'),
            },
          ],
        }),
      },
    });

    expect(() =>
      withoutPilot.recentDecisions({
        request: recentRequest(),
        access_token: 'valid',
      }),
    ).toThrow(
      expect.objectContaining<Partial<OrganizationRecentDecisionsError>>({
        code: 'unavailable',
      }),
    );
    expect(
      withoutPilot.reviewerRecentDecisions({
        request: reviewerRequest(),
        access_token: 'valid',
      }).body,
    ).toEqual(
      prepareReviewerRecentDecisionsResponse([
        {
          kind: 'decision',
          text: 'Reviewer-only decision.',
          atom_id: digest('reviewer atom'),
          record_hash: digest('reviewer record'),
        },
      ]).body,
    );
  });

  it('audits a final revocation and releases no prepared content', () => {
    const { port, audits } = createPort({
      final: {
        decision: 'deny',
        reason_code: 'authorization_state_changed',
        checked_at: '2026-08-18T00:00:01.000Z',
      },
    });
    const response = application(port).recentDecisions({
      request: recentRequest(),
      access_token: 'valid',
    });

    expect(response.status_code).toBe(401);
    expect(response.body).not.toEqual(prepareAllowedRecentDecisionsResponse(records).body);
    expect(Buffer.from(response.body).toString('utf8')).not.toContain('pricing');
    expect(audits).toMatchObject([
      { decision: 'deny', reason_code: 'authorization_state_changed' },
    ]);
  });

  it('rechecks reviewer session state and releases no prepared content', () => {
    const { port, audits } = createPort({
      final: {
        decision: 'deny',
        reason_code: 'authorization_state_changed',
        checked_at: '2026-08-18T00:00:01.000Z',
      },
    });
    const response = application(port).reviewerRecentDecisions({
      request: reviewerRequest(),
      access_token: 'valid',
    });

    expect(response.status_code).toBe(401);
    expect(Buffer.from(response.body).toString('utf8')).not.toContain(
      'Reviewer-only decision',
    );
    expect(audits).toMatchObject([
      { decision: 'deny', reason_code: 'authorization_state_changed' },
    ]);
  });
});
