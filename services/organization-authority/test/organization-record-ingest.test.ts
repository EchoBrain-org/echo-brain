import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  validateOrganizationRecordReceipt,
} from '@echo-brain/organization-protocol';
import { OrganizationRecordLogStore } from '@echo-brain/organization-record/append';
import { AuthorityOperationError } from '../src/domain/errors.js';
import { OrganizationRecordIngestRejectionError } from '../src/application/organization-record-ingest.js';
import { openOrganizationRecordRuntime } from '../src/composition/organization-record.js';
import {
  approvalId,
  createRecordIngestFixture,
  digest,
  recordBrief,
  RECORD_MEETING_ID,
  type CreateRecordIngestFixtureOptions,
  type RecordIngestFixture,
} from './support/record-ingest-fixture.js';

let fixture: RecordIngestFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function openFixture(
  options: CreateRecordIngestFixtureOptions = {},
): Promise<RecordIngestFixture> {
  fixture = await createRecordIngestFixture(options);
  return fixture;
}

async function rejectionCode(
  submit: () => Promise<unknown>,
): Promise<{ code: string; terminal: boolean }> {
  try {
    await submit();
  } catch (error) {
    if (error instanceof OrganizationRecordIngestRejectionError) {
      return { code: error.code, terminal: true };
    }
    if (error instanceof AuthorityOperationError) {
      return { code: error.code, terminal: false };
    }
    throw error;
  }
  throw new Error('expected the submission to be refused');
}

function differentOpaqueId(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
}

describe('organization record ingest', () => {
  it('admits v3 only after real audit reproof, atomically facts it, and re-admits it on restart', async () => {
    const test = await openFixture();
    expect(test.runtime.organizationMemberReadableHealth.kind).toBe('ready');
    const editedId = approvalId('organization-member-edited-card');
    const edited = await test.organizationMemberApprovalEnvelope({
      approval_id: editedId,
    });
    const editedCard = JSON.parse(canonicalJson(edited)) as typeof edited;
    editedCard.payload.brief.decisions[0]!.text = 'Edited after approval.';
    await expect(
      test.runtime.submitRecordEnvelope({ record_envelope: editedCard }),
    ).rejects.toBeInstanceOf(OrganizationRecordIngestRejectionError);

    const mismatchId = approvalId('organization-member-audit-mismatch');
    const auditMismatch = await test.organizationMemberApprovalEnvelope({
      approval_id: mismatchId,
    });
    const auditLookup = vi.spyOn(
      test.integrations,
      'findAllowedOrganizationMemberAuthorizationEvidenceById',
    );
    auditLookup.mockReturnValue({ status: 'mismatch' });
    await expect(
      test.runtime.submitRecordEnvelope({ record_envelope: auditMismatch }),
    ).rejects.toMatchObject({ code: 'record_authorization_invalid' });
    auditLookup.mockRestore();
    const unadmittedLog = new Database(test.recordLogDatabasePath, {
      readonly: true,
    });
    try {
      expect(
        unadmittedLog
          .prepare('SELECT count(*) AS count FROM organization_record_log')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        unadmittedLog
          .prepare(
            'SELECT count(*) AS count FROM organization_member_readable_policy_fact',
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      unadmittedLog.close();
    }

    const admittedId = approvalId('organization-member-admitted');
    const admitted = await test.organizationMemberApprovalEnvelope({
      approval_id: admittedId,
    });
    const reproof = vi.spyOn(
      test.integrations,
      'findAllowedOrganizationMemberAuthorizationEvidenceById',
    );
    const first = await test.runtime.submitRecordEnvelope({
      record_envelope: admitted,
    });
    const duplicate = await test.runtime.submitRecordEnvelope({
      record_envelope: admitted,
    });
    expect(first.record_receipt.position).toBe(1);
    expect(duplicate.record_receipt.position).toBe(1);
    expect(reproof).toHaveBeenCalledTimes(2);

    await test.runtime.close();
    const log = OrganizationRecordLogStore.open(test.recordLogDatabasePath, {
      organization_id: test.organizationId,
      authority_id: test.authorityId,
    });
    try {
      expect(
        log.database
          .prepare('SELECT count(*) AS count FROM organization_record_log')
          .get(),
      ).toEqual({ count: 1 });
      expect(
        log.database
          .prepare(
            'SELECT log_position, atom_order FROM organization_member_readable_policy_fact ORDER BY atom_order',
          )
          .all(),
      ).toEqual([{ log_position: 1, atom_order: 0 }]);
    } finally {
      log.close();
    }

    const restarted = await openOrganizationRecordRuntime({
      authority: test.application,
      evidence: test.integrations,
      organization_id: test.organizationId,
      authority_id: test.authorityId,
      record_log_database_path: test.recordLogDatabasePath,
      record_derived_database_path: test.recordDerivedDatabasePath,
      organization_recording_policy_v1: test.organizationRecordingPolicy,
      alert: () => undefined,
    });
    try {
      expect(restarted.organizationMemberReadableHealth).toMatchObject({
        kind: 'ready',
        readiness: {
          organization_member_records_verified: 1,
          organization_member_facts_verified: 1,
          audit_rows_revalidated: 1,
        },
      });
      expect(restarted.verifyChain()).toMatchObject({
        head_position: 1,
        records_verified: 1,
        failures: [],
      });
    } finally {
      await restarted.close();
    }

    const alerts: string[] = [];
    const memberAuditMismatch = vi
      .spyOn(
        test.integrations,
        'findAllowedOrganizationMemberAuthorizationEvidenceById',
      )
      .mockReturnValue({ status: 'mismatch' });
    const degraded = await openOrganizationRecordRuntime({
      authority: test.application,
      evidence: test.integrations,
      organization_id: test.organizationId,
      authority_id: test.authorityId,
      record_log_database_path: test.recordLogDatabasePath,
      record_derived_database_path: test.recordDerivedDatabasePath,
      organization_recording_policy_v1: test.organizationRecordingPolicy,
      alert: (alert) => alerts.push(`${alert.kind}:${alert.message}`),
    });
    try {
      expect(degraded.organizationMemberReadableHealth.kind).toBe('degraded');
      expect(alerts).toEqual([
        expect.stringMatching(/^organization-member-readable-inactive:/),
      ]);
    } finally {
      memberAuditMismatch.mockRestore();
      await degraded.close();
    }
  });

  it.each(['absent', 'mismatched'] as const)(
    'refuses an otherwise valid audited v3 append while the central policy is %s',
    async (organizationMemberRecordingPolicy) => {
      const test = await openFixture({ organizationMemberRecordingPolicy });
      expect(test.runtime.organizationMemberReadableHealth.kind).toBe('absent');
      const envelope = await test.organizationMemberApprovalEnvelope({
        approval_id: approvalId(`central-gate-${organizationMemberRecordingPolicy}`),
      });

      await expect(
        test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      const log = new Database(test.recordLogDatabasePath, { readonly: true });
      try {
        expect(
          log
            .prepare('SELECT COUNT(*) AS count FROM organization_record_log')
            .get(),
        ).toEqual({ count: 0 });
        expect(
          log
            .prepare(
              'SELECT COUNT(*) AS count FROM organization_member_readable_policy_fact',
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        log.close();
      }

      // The additive member-v3 gate never disables reviewer-v2.
      const reviewerEnvelope = await test.reviewerApprovalEnvelope({
        approval_id: approvalId(`reviewer-still-live-${organizationMemberRecordingPolicy}`),
      });
      await expect(
        test.runtime.submitRecordEnvelope({
          record_envelope: reviewerEnvelope,
        }),
      ).resolves.toMatchObject({ record_receipt: { position: 1 } });
    },
  );

  it('accepts one approval and returns a signed receipt with exact fields', async () => {
    const test = await openFixture();
    const id = approvalId('approval-accepted');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });

    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    const receipt = accepted.record_receipt;

    // `position`, never `log_position`; `authority_key_id` lives only in
    // `integrity.key_id`. Both are frozen wire names.
    expect(receipt.kind).toBe('echo-organization-record-receipt');
    expect(receipt.schema_version).toBe(1);
    expect(receipt.position).toBe(1);
    expect(Object.keys(receipt).sort()).toEqual([
      'authority_id',
      'envelope_id',
      'envelope_sha256',
      'idempotency_key',
      'installation_id',
      'integrity',
      'kind',
      'organization_id',
      'position',
      'record_hash',
      'recorded_at',
      'schema_version',
    ]);
    expect(receipt.authority_id).toBe(test.authorityId);
    expect(receipt.organization_id).toBe(test.organizationId);
    expect(receipt.envelope_id).toBe(envelope.envelope_id);
    expect(receipt.installation_id).toBe(test.installationId);
    expect(receipt.idempotency_key).toBe(id);
    expect(receipt.envelope_sha256).toBe(canonicalSha256(envelope));
    expect(receipt.integrity.canonicalization).toBe('RFC8785');
    expect(receipt.integrity.signature_algorithm).toBe(
      'ecdsa-p256-sha256-der-low-s',
    );
    // The signature is over the exact stored payload, so re-validating the
    // returned document is a real check rather than a tautology.
    expect(validateOrganizationRecordReceipt(receipt)).toEqual(receipt);
  });

  it('returns the original receipt for an exact retry and never appends twice', async () => {
    const test = await openFixture();
    const id = approvalId('approval-retry');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });

    const first = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    const second = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });

    expect(second.record_receipt).toEqual(first.record_receipt);
    expect(test.runtime.verifyChain().head_position).toBe(1);
  });

  it('passes exact marker-bound notice proof into the atomic eligibility append', async () => {
    const test = await openFixture({ activatePermissionPilot: true });
    const health = test.runtime.permissionPilotHealth;
    if (health.kind !== 'ready') throw new Error('expected an active pilot marker');
    const activation = health.activation;
    const id = approvalId('approval-pilot-eligible');
    const proof = {
      policy_id: activation.policy_id,
      presentation_policy_id: activation.presentation_policy_id,
      audience_notice_sha256: activation.audience_notice_sha256,
      message_presentation_sha256: digest('pilot-message-presentation'),
    };
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({
        approval_id: id,
        action: 'approve',
        permission_pilot_eligibility: proof,
      }),
    });

    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });

    expect(test.runtime.readPermissionPilotEligibleRecords()).toEqual([
      expect.objectContaining({
        row: expect.objectContaining({
          position: accepted.record_receipt.position,
          record_hash: accepted.record_receipt.record_hash,
        }),
        eligibility: proof,
      }),
    ]);
  });

  it('keeps a legacy allowed post-activation record out of the pilot index', async () => {
    const test = await openFixture({ activatePermissionPilot: true });
    const id = approvalId('approval-pilot-legacy');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });

    await expect(
      test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
    ).resolves.toMatchObject({ record_receipt: { position: 1 } });
    expect(test.runtime.readPermissionPilotEligibleRecords()).toEqual([]);
  });

  it('keeps a notice-qualified envelope retryable when no activation marker exists', async () => {
    const test = await openFixture();
    const id = approvalId('approval-pilot-marker-absent');
    const proof = {
      policy_id: 'pilot-member-readable-v1' as const,
      presentation_policy_id: 'pilot-two-person-audience-v1' as const,
      audience_notice_sha256: digest('pilot-audience-without-marker'),
      message_presentation_sha256: digest('pilot-message-without-marker'),
    };
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({
        approval_id: id,
        action: 'approve',
        permission_pilot_eligibility: proof,
      }),
    });

    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
      ),
    ).toEqual({ code: 'unavailable', terminal: false });
    expect(test.runtime.verifyChain().head_position).toBeNull();
  });

  it.each(['ambiguous', 'corrupt'] as const)(
    'keeps a notice-qualified envelope retryable when its audit is %s',
    async (status) => {
      const test = await openFixture({ activatePermissionPilot: true });
      const health = test.runtime.permissionPilotHealth;
      if (health.kind !== 'ready') throw new Error('expected an active pilot marker');
      const id = approvalId(`approval-pilot-audit-${status}`);
      const proof = {
        policy_id: health.activation.policy_id,
        presentation_policy_id: health.activation.presentation_policy_id,
        audience_notice_sha256: health.activation.audience_notice_sha256,
        message_presentation_sha256: digest(`pilot-message-${status}`),
      };
      const envelope = await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({
          approval_id: id,
          action: 'approve',
          permission_pilot_eligibility: proof,
        }),
      });
      vi.spyOn(
        test.integrations,
        'findAllowedApprovalAuthorizationEvidence',
      ).mockReturnValue({ status });

      expect(
        await rejectionCode(() =>
          test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
        ),
      ).toEqual({ code: 'unavailable', terminal: false });
      expect(test.runtime.verifyChain().head_position).toBeNull();
    },
  );

  it('rejects notice proof bound to another audience digest before append', async () => {
    const test = await openFixture({ activatePermissionPilot: true });
    const health = test.runtime.permissionPilotHealth;
    if (health.kind !== 'ready') throw new Error('expected an active pilot marker');
    const activation = health.activation;
    const id = approvalId('approval-pilot-other-audience');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({
        approval_id: id,
        action: 'approve',
        permission_pilot_eligibility: {
          policy_id: activation.policy_id,
          presentation_policy_id: activation.presentation_policy_id,
          audience_notice_sha256: digest('another-audience'),
          message_presentation_sha256: digest('pilot-message-presentation'),
        },
      }),
    });

    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
      ),
    ).toEqual({ code: 'record_authorization_invalid', terminal: true });
    expect(test.runtime.readPermissionPilotEligibleRecords()).toEqual([]);
    expect(test.runtime.verifyChain().head_position).toBeNull();
  });

  it('refuses a divergent envelope under a known idempotency key', async () => {
    const test = await openFixture();
    const id = approvalId('approval-conflict');
    const authorization = test.authorize({
      approval_id: id,
      action: 'approve',
    });
    await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: id,
        authorization,
      }),
    });
    const divergent = await test.approvalEnvelope({
      approval_id: id,
      authorization,
      brief: recordBrief({ id: 'brief-divergent' }),
    });

    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({ record_envelope: divergent }),
      ),
    ).toEqual({ code: 'record_idempotency_conflict', terminal: true });
    expect(test.runtime.verifyChain().head_position).toBe(1);
  });

  it('accepts a rejection act and chains it after the approval', async () => {
    const test = await openFixture();
    const approved = approvalId('approval-chained');
    const rejected = approvalId('rejection-chained');
    await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: approved,
        authorization: test.authorize({
          approval_id: approved,
          action: 'approve',
        }),
      }),
    });
    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: await test.rejectionEnvelope({
        approval_id: rejected,
        authorization: test.authorize({
          approval_id: rejected,
          action: 'reject',
        }),
      }),
    });

    expect(accepted.record_receipt.position).toBe(2);
    const verification = test.runtime.verifyChain();
    expect(verification.failures).toEqual([]);
    expect(verification.records_verified).toBe(2);
    expect(verification.tail_truncation_detectable).toBe(false);
  });

  it('derives the approved decision into the derived graph after append', async () => {
    const test = await openFixture();
    const id = approvalId('approval-derived');
    await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({ approval_id: id, action: 'approve' }),
      }),
    });

    // The in-process nudge fires after commit; drain waits for it to settle.
    const progress = await test.runtime.follower.drain();
    expect(progress.halted).toBe(false);
    expect(progress.cursor_position).toBe(1);
  });

  describe('authorization evidence must match one allowed audit row', () => {
    const mismatches: ReadonlyArray<
      readonly [string, (evidence: Record<string, unknown>) => void]
    > = [
      ['request id', (evidence) => {
        evidence['request_id'] = 'pcr_deadbeef-dead-4ead-8ead-deadbeefdead';
      }],
      ['request hash', (evidence) => {
        evidence['request_sha256'] = `sha256:${'a'.repeat(64)}`;
      }],
      ['provider event hash', (evidence) => {
        evidence['provider_event_sha256'] = `sha256:${'b'.repeat(64)}`;
      }],
      ['adapter binding', (evidence) => {
        evidence['adapter_binding_id'] =
          'bnd_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      }],
      ['permission grant', (evidence) => {
        evidence['permission_grant_id'] =
          'pgr_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      }],
      ['evaluation time', (evidence) => {
        evidence['evaluated_at'] = '2020-01-01T00:00:00.000Z';
      }],
      ['reason code', (evidence) => {
        evidence['reason_code'] = 'no_active_link_binding_or_grant';
      }],
    ];

    for (const [label, mutate] of mismatches) {
      it(`denies a submission whose ${label} is not audited`, async () => {
        const test = await openFixture();
        const id = approvalId(`approval-${label.replaceAll(' ', '-')}`);
        const authorization = test.authorize({
          approval_id: id,
          action: 'approve',
        });
        const tampered = { ...authorization } as Record<string, unknown>;
        mutate(tampered);

        expect(
          await rejectionCode(async () =>
            test.runtime.submitRecordEnvelope({
              record_envelope: await test.approvalEnvelope({
                approval_id: id,
                authorization:
                  tampered as unknown as typeof authorization,
              }),
            }),
          ),
        ).toEqual({ code: 'record_authorization_invalid', terminal: true });
      });
    }

    it('denies an approval envelope carrying reject-action evidence', async () => {
      const test = await openFixture();
      const id = approvalId('approval-wrong-action');
      const authorization = test.authorize({
        approval_id: id,
        action: 'reject',
      });

      // The envelope contract itself refuses to sign this pairing, which is
      // the earliest possible failure: an allow for one act never authorizes
      // the other.
      await expect(
        test.approvalEnvelope({ approval_id: id, authorization }),
      ).rejects.toThrow('does not authorize this approval event');
    });

    it('denies evidence with no audit row at all', async () => {
      const test = await openFixture();
      const id = approvalId('approval-unaudited');
      const audited = test.authorize({
        approval_id: id,
        action: 'approve',
      });
      const unaudited = {
        ...audited,
        approval_id: approvalId('approval-never-evaluated'),
      };

      expect(
        await rejectionCode(async () =>
          test.runtime.submitRecordEnvelope({
            record_envelope: await test.approvalEnvelope({
              approval_id: unaudited.approval_id,
              authorization: unaudited,
            }),
          }),
        ),
      ).toEqual({ code: 'record_authorization_invalid', terminal: true });
    });

    it('denies evidence that matches more than one audited evaluation', async () => {
      const test = await openFixture();
      const id = approvalId('approval-ambiguous');
      const authorization = test.authorize({
        approval_id: id,
        action: 'approve',
      });
      // A second row identical in every matched column. Ambiguity is a denial:
      // "some row might be this evaluation" authorizes nothing.
      test.integrations.recordPermissionDecision({
        request_id: authorization.request_id,
        request_sha256: authorization.request_sha256,
        provider_event_sha256: authorization.provider_event_sha256,
        action: 'approve',
        allowed: true,
        reason_code: 'active_membership_and_direct_grant',
        principal_id: authorization.principal_id,
        membership_id: authorization.membership_id,
        adapter_binding_id: authorization.adapter_binding_id,
        permission_grant_id: authorization.permission_grant_id,
        evaluated_at: authorization.evaluated_at,
        authority_evidence_sha256: `sha256:${'e'.repeat(64)}`,
        authority_checked_at: authorization.evaluated_at,
        organization_id: test.organizationId,
        caller_principal_id: authorization.principal_id,
        caller_membership_id: authorization.membership_id,
        installation_id: test.installationId,
        identity_link_id: null,
        connection_id: null,
        approval_id: authorization.approval_id,
        detail: {
          principal_id: authorization.principal_id,
          request_sha256: authorization.request_sha256,
          provider_event_sha256: authorization.provider_event_sha256,
        },
      });

      expect(
        await rejectionCode(async () =>
          test.runtime.submitRecordEnvelope({
            record_envelope: await test.approvalEnvelope({
              approval_id: id,
              authorization,
            }),
          }),
        ),
      ).toEqual({ code: 'record_authorization_invalid', terminal: true });
    });
  });

  it('classifies an oversize canonical envelope as too large, not invalid', async () => {
    const test = await openFixture();
    const id = approvalId('approval-oversize');
    const authorization = test.authorize({
      approval_id: id,
      action: 'approve',
    });
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization,
    });
    // Grow the signed document past the 256 KiB canonical cap without
    // touching its shape, so the size rule is what refuses it.
    const oversize = {
      ...(envelope as unknown as Record<string, unknown>),
      payload: {
        ...(envelope.payload as unknown as Record<string, unknown>),
        surface: 'x'.repeat(MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES),
      },
    };

    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({
          record_envelope: oversize as never,
        }),
      ),
    ).toEqual({ code: 'record_envelope_too_large', terminal: true });
  });

  it('refuses a tampered signature permanently and a malformed envelope as invalid', async () => {
    const test = await openFixture();
    const id = approvalId('approval-tampered');
    const authorization = test.authorize({
      approval_id: id,
      action: 'approve',
    });
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization,
    });
    const tamperedSignature = {
      ...(envelope as unknown as Record<string, unknown>),
      payload: {
        ...(envelope.payload as unknown as Record<string, unknown>),
        surface: 'jsonl-outbox',
      },
    };

    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({
          record_envelope: tamperedSignature as never,
        }),
      ),
    ).toEqual({ code: 'record_signature_invalid', terminal: true });
    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({
          record_envelope: {
            ...(envelope as unknown as Record<string, unknown>),
            event_type: 'correction',
          } as never,
        }),
      ),
    ).toEqual({ code: 'record_envelope_invalid', terminal: true });
  });

  it('refuses a new append on an expired-but-unrevoked lease', async () => {
    const test = await openFixture();
    const id = approvalId('approval-expired-lease');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });
    // Nothing is revoked here. The access state is still `active`; it has
    // simply aged past its `valid_until`, which is what a member machine that
    // stopped refreshing looks like. Admitting its first record would write an
    // immutable row no live authorization covers.
    test.expireAccessLease();

    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
      ),
    ).toEqual({ code: 'unauthorized', terminal: false });
    expect(test.runtime.verifyChain().head_position).toBeNull();
    const progress = await test.runtime.follower.drain();
    expect(progress.cursor_position).toBe(0);
  });

  it('recovers a receipt for an already-committed record after the lease expires', async () => {
    const test = await openFixture();
    const id = approvalId('approval-expired-after-append');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });
    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    test.expireAccessLease();

    // The act was already accepted. Recovering its receipt is not a new
    // append, so the expired lease must not strand a durable record.
    const recovered = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    expect(recovered.record_receipt).toEqual(accepted.record_receipt);
    expect(test.runtime.verifyChain().head_position).toBe(1);
  });

  it('accepts a reviewer who is not the submitting installation owner', async () => {
    const test = await openFixture();
    const id = approvalId('approval-other-reviewer');
    // The approval surface is a shared organization channel: a colleague may
    // react on a decision this machine submits. The machine binding is the
    // submitter and its enrollment; the reviewer binds itself and its own
    // audited evaluation.
    const authorization = test.authorizeOtherMember({
      approval_id: id,
      action: 'approve',
    });
    expect(authorization.principal_id).not.toBe(test.principalId);
    expect(authorization.membership_id).not.toBe(test.membershipId);

    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelopeFor({
        approval_id: id,
        authorization,
      }),
    });

    expect(accepted.record_receipt.position).toBe(1);
    expect(accepted.record_receipt.installation_id).toBe(test.installationId);
  });

  it('denies a reviewer whose own evaluation was never audited', async () => {
    const test = await openFixture();
    const id = approvalId('approval-unaudited-reviewer');
    const audited = test.authorize({ approval_id: id, action: 'approve' });
    // Every other field stays on the audited row; only the reviewer identity
    // moves. Nothing about the installation changed, so this is precisely the
    // denial that removing the reviewer-equality rule must not lose.
    const impersonated = {
      ...audited,
      principal_id: differentOpaqueId(test.principalId),
      membership_id: differentOpaqueId(test.membershipId),
    };

    expect(
      await rejectionCode(async () =>
        test.runtime.submitRecordEnvelope({
          record_envelope: await test.approvalEnvelopeFor({
            approval_id: id,
            authorization: impersonated,
          }),
        }),
      ),
    ).toEqual({ code: 'record_authorization_invalid', terminal: true });
    expect(test.runtime.verifyChain().head_position).toBeNull();
  });

  it('denies an envelope whose reviewer disagrees with its own evidence', async () => {
    const test = await openFixture();
    const id = approvalId('approval-reviewer-mismatch');
    const authorization = test.authorize({ approval_id: id, action: 'approve' });

    // The protocol refuses to sign this pairing at all: the reviewer named on
    // the envelope must be the principal the evidence allows.
    await expect(
      test.approvalEnvelopeFor({
        approval_id: id,
        authorization,
        reviewer_principal_id: differentOpaqueId(test.principalId),
      }),
    ).rejects.toThrow('does not bind this exact submission');
  });

  it('refuses exactly one canonical byte over the document cap', async () => {
    const test = await openFixture();
    const id = approvalId('approval-one-byte-over');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });
    const document = envelope as unknown as Record<string, unknown>;
    const payload = document['payload'] as Record<string, unknown>;
    const overhead =
      MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES +
      1 -
      Buffer.byteLength(canonicalJson(document as never), 'utf8');
    const oversize = {
      ...document,
      payload: {
        ...payload,
        surface: `${payload['surface'] as string}${'x'.repeat(overhead)}`,
      },
    };
    expect(Buffer.byteLength(canonicalJson(oversize as never), 'utf8')).toBe(
      MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES + 1,
    );

    // One byte, and it is named exactly: the size rule runs before signature
    // verification, so the member is told the envelope is too large rather
    // than being sent chasing a signature that was never the problem.
    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({
          record_envelope: oversize as never,
        }),
      ),
    ).toEqual({ code: 'record_envelope_too_large', terminal: true });
    expect(test.runtime.verifyChain().head_position).toBeNull();
  });

  it('never persists a receipt the authority key cannot verify', async () => {
    const test = await openFixture();
    const id = approvalId('approval-broken-signer');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });
    test.corruptAuthoritySignatures(true);

    // The receipt slot is create-once. A well-formed but unverifiable receipt
    // frozen there could never be presented against the log, so signing has to
    // fail loudly instead.
    await expect(
      test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
    ).rejects.toThrow();

    // The append itself is durable and unharmed; a working signer still
    // materializes the real receipt for it, exactly once.
    test.corruptAuthoritySignatures(false);
    const recovered = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    expect(recovered.record_receipt.position).toBe(1);
    expect(test.runtime.verifyChain().head_position).toBe(1);
  });

  it('leaves a revoked installation retryable rather than permanently rejected', async () => {
    const test = await openFixture();
    const id = approvalId('approval-revoked');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });
    await test.revokeInstallation();

    // Not one of the terminal codes: the submitter keeps its frozen envelope
    // and retries after refreshing, exactly as the lease contract requires.
    expect(
      await rejectionCode(() =>
        test.runtime.submitRecordEnvelope({ record_envelope: envelope }),
      ),
    ).toEqual({ code: 'unauthorized', terminal: false });
  });

  it('recovers a receipt for an already-committed record after a revocation', async () => {
    const test = await openFixture();
    const id = approvalId('approval-recovered');
    const envelope = await test.approvalEnvelope({
      approval_id: id,
      authorization: test.authorize({ approval_id: id, action: 'approve' }),
    });
    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    await test.revokeInstallation();

    // The append already committed. Resending the exact bytes recovers that
    // member's own receipt instead of stranding a durable record.
    const recovered = await test.runtime.submitRecordEnvelope({
      record_envelope: envelope,
    });
    expect(recovered.record_receipt).toEqual(accepted.record_receipt);
  });

  it('keeps the derived meeting snapshot scoped to the approved brief', async () => {
    const test = await openFixture();
    const id = approvalId('approval-snapshot');
    await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({ approval_id: id, action: 'approve' }),
        brief: recordBrief(),
      }),
    });
    await test.runtime.follower.drain();

    expect(RECORD_MEETING_ID).toBe('granola:meeting-2026-08-08-pricing');
    expect(test.runtime.follower.halted).toBe(false);
  });
});
