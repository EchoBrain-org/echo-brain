import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
} from '@echo-brain/organization-api';
import {
  createOrganizationRecordReceipt,
  organizationAuthorityPinSha256,
  validateOrganizationRecordEnvelope,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type {
  CanonicalPayloadSigner,
  OrganizationAuthorityDescriptorV1,
  OrganizationRecordEnvelopeV1,
  OrganizationRecordReceiptV1,
} from '@echo-brain/organization-protocol';
import { HttpOrganizationRecordClient } from '../../src/product/organization/client/http-organization-record-client.js';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '@echo-brain/organization-authority/processing/record/protocol-record-envelope-builder.js';
import type {
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordEnvelopeBuildInput,
} from '../../src/product/organization/record/index.js';

const NOW = '2026-08-08T12:00:00.000Z';
const APPROVAL_ID = 'a'.repeat(64);
const MEETING_ID = 'granola:meeting-2026-08-08';

function id(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${suffix
    .toString()
    .padStart(12, '0')}`;
}

const IDS = {
  authority: id('oau', 1),
  organization: id('org', 1),
  principal: id('prn', 1),
  membership: id('mem', 1),
  installation: id('ins', 1),
  enrollment: id('enr', 1),
  binding: id('bnd', 1),
  grant: id('pgr', 1),
  request: id('pcr', 1),
} as const;

function digest(seed: string): `sha256:${string}` {
  return canonicalSha256(seed);
}

interface GeneratedKey {
  descriptor: P256SigningKeyDescriptor;
  sign: CanonicalPayloadSigner;
  privateKey: KeyObject;
}

function generatedKey(): GeneratedKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(der)) throw new Error('unexpected key export');
  return {
    descriptor: {
      key_id: p256KeyId(der),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: der.toString('base64'),
    },
    sign: async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }),
      ),
    privateKey,
  };
}

function authorityFixture() {
  const key = generatedKey();
  const descriptor: OrganizationAuthorityDescriptorV1 = {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    signing_key: key.descriptor,
  };
  return {
    key,
    descriptor,
    pinned: verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    ),
  };
}

function evidence(
  action: 'approve' | 'reject' = 'approve',
): OrganizationRecordAuthorizationEvidence {
  return {
    schema_version: 1,
    kind: 'echo-organization-authorization-evidence',
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    enrollment_id: IDS.enrollment,
    installation_id: IDS.installation,
    request_id: IDS.request,
    approval_id: APPROVAL_ID,
    action,
    request_sha256: digest('request'),
    provider_event_sha256: digest('provider-event'),
    allowed: true,
    reason_code: 'active_membership_and_direct_grant',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: NOW,
  };
}

function buildInput(
  overrides: Partial<OrganizationRecordEnvelopeBuildInput> = {},
): OrganizationRecordEnvelopeBuildInput {
  return {
    event_type: 'approval',
    approval_id: APPROVAL_ID,
    source: {
      adapter_id: 'granola',
      instance_id: 'primary',
      external_id: 'granola-2026-08-08',
    },
    meeting_id: MEETING_ID,
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: { id: MEETING_ID, participants: [] },
      decisions: [
        {
          id: 'signal-1',
          kind: 'decision',
          text: 'Ship the pilot tier.',
          subject: null,
          confidence: null,
          evidence: [{ meeting_id: MEETING_ID, block_id: 'block-1' }],
          status: 'decided',
        },
      ],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'rev-1',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'structured-text',
          instance_id: 'default',
          version: '1.0.0',
        },
        generated_at: NOW,
      },
    },
    alternatives: [],
    links: { parent: null, supersedes: null },
    reviewed_at: NOW,
    reviewed_by: 'Ada Founder',
    reason: null,
    surface: 'slack-reactions',
    authorization: evidence(),
    submitted_at: NOW,
    ...overrides,
  };
}

describe('protocol organization record envelope builder', () => {
  const authority = authorityFixture();
  const installation = generatedKey();
  const builder = new ProtocolOrganizationRecordEnvelopeBuilder({
    pinnedAuthority: authority.pinned,
    installationSigningKey: installation.descriptor,
    sign: installation.sign,
  });

  it('builds a protocol-valid signed approval envelope', async () => {
    const built = await builder.build(buildInput());

    const envelope = validateOrganizationRecordEnvelope(built.envelope);
    if (envelope.event_type !== 'approval') throw new Error('expected approval');
    expect(built.event_type).toBe('approval');
    expect(built.idempotency_key).toBe(APPROVAL_ID);
    expect(built.envelope_id).toMatch(/^rec_/);
    expect(envelope.payload.links).toBeNull();
    expect(envelope.payload.alternatives).toEqual([]);
    expect(envelope.payload.reviewed_at).toBe(NOW);
    expect(envelope.intent).toEqual({
      restricted: true,
      reconsider_after: null,
    });
    expect(envelope.reviewer.principal_id).toBe(IDS.principal);
    expect(envelope.reviewer.reviewed_by).toBe('Ada Founder');
    expect(envelope.submitter.installation_id).toBe(IDS.installation);
    expect(envelope.integrity.key_id).toBe(installation.descriptor.key_id);
  });

  it('builds a rejection envelope with no brief and a null reconsider_after', async () => {
    const built = await builder.build(
      buildInput({
        event_type: 'rejection',
        brief: null,
        reason: 'Not yet.',
        authorization: evidence('reject'),
      }),
    );

    const envelope = validateOrganizationRecordEnvelope(built.envelope);
    if (envelope.event_type !== 'rejection') throw new Error('expected rejection');
    expect(built.event_type).toBe('rejection');
    // A rejection records the act, never the candidate content: no brief, no
    // alternatives, no links, and no approval intent.
    expect(Object.keys(envelope.payload).sort()).toEqual([
      'meeting_id',
      'reason',
      'reconsider_after',
      'rejected_at',
      'source',
    ]);
    expect(envelope.payload.reason).toBe('Not yet.');
    expect(envelope.payload.reconsider_after).toBeNull();
    expect(envelope.payload.rejected_at).toBe(NOW);
    expect(envelope).not.toHaveProperty('intent');
  });

  it('refuses to build when a node carries decision links v1 cannot express', async () => {
    await expect(
      builder.build(
        buildInput({ links: { parent: 'brief-0', supersedes: null } }),
      ),
    ).rejects.toThrow('carries no decision links');
    await expect(
      builder.build(
        buildInput({ links: { parent: null, supersedes: 'brief-0' } }),
      ),
    ).rejects.toThrow('carries no decision links');
  });
});

describe('http organization record client', () => {
  const authority = authorityFixture();
  const installation = generatedKey();
  const builder = new ProtocolOrganizationRecordEnvelopeBuilder({
    pinnedAuthority: authority.pinned,
    installationSigningKey: installation.descriptor,
    sign: installation.sign,
  });

  async function submission() {
    const built = await builder.build(buildInput());
    return {
      envelope_id: built.envelope_id,
      idempotency_key: built.idempotency_key,
      envelope_sha256: canonicalSha256(built.envelope),
      envelope: built.envelope as Record<string, unknown>,
    };
  }

  async function signedReceipt(
    envelope: OrganizationRecordEnvelopeV1,
    overrides: { position?: number } = {},
  ): Promise<OrganizationRecordReceiptV1> {
    return createOrganizationRecordReceipt(
      {
        envelope,
        installation_signing_key: installation.descriptor,
        position: overrides.position ?? 1,
        record_hash: digest('record-hash'),
        recorded_at: NOW,
      },
      authority.pinned,
      authority.key.sign,
    );
  }

  function client(
    respond: (request: Request) => Promise<Response>,
    options: { authority?: ReturnType<typeof authorityFixture> } = {},
  ): HttpOrganizationRecordClient {
    return new HttpOrganizationRecordClient({
      baseUrl: 'http://127.0.0.1:39479/',
      pinnedAuthority: (options.authority ?? authority).pinned,
      installationSigningKey: installation.descriptor,
      allowInsecureLoopback: true,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        respond(new Request(input as never, init))) as typeof fetch,
    });
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  it('accepts a receipt that verifies against the pinned authority key', async () => {
    const outbound = await submission();
    const receipt = await signedReceipt(
      outbound.envelope as unknown as OrganizationRecordEnvelopeV1,
    );
    let requestedPath: string | undefined;

    const result = await client(async (request) => {
      requestedPath = new URL(request.url).pathname;
      return jsonResponse(200, { record_receipt: receipt });
    }).submitRecord(outbound);

    expect(requestedPath).toBe(ORGANIZATION_API_RECORD_ENVELOPES_PATH);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') throw new Error('unreachable');
    expect(result.receipt.position).toBe(1);
    expect(result.receipt.envelope_sha256).toBe(outbound.envelope_sha256);
    expect(result.receipt.kind).toBe('echo-organization-record-receipt');
  });

  it('refuses a receipt signed by another authority key', async () => {
    const outbound = await submission();
    const impostor = authorityFixture();
    const receipt = await createOrganizationRecordReceipt(
      {
        envelope: outbound.envelope as unknown as OrganizationRecordEnvelopeV1,
        installation_signing_key: installation.descriptor,
        position: 1,
        record_hash: digest('record-hash'),
        recorded_at: NOW,
      },
      impostor.pinned,
      impostor.key.sign,
    );

    // Verification against the *pinned* key, not merely a well-formed
    // document: an unpinned signer is never an accepted outcome.
    const result = await client(async () =>
      jsonResponse(200, { record_receipt: receipt }),
    ).submitRecord(outbound);

    expect(result.outcome).toBe('retry');
  });

  it('maps every permanent code to a terminal rejection', async () => {
    const outbound = await submission();
    for (const code of [
      'record_envelope_invalid',
      'record_envelope_too_large',
      'record_signature_invalid',
      'record_authorization_invalid',
      'record_idempotency_conflict',
    ]) {
      const result = await client(async () =>
        jsonResponse(code === 'record_idempotency_conflict' ? 409 : 400, {
          error: { code, message: 'refused' },
        }),
      ).submitRecord(outbound);

      expect(result).toEqual({
        outcome: 'rejected',
        reason_code: code,
        reason: 'refused',
      });
    }
  });

  it('leaves an unrecognized failure and a transport fault retryable', async () => {
    const outbound = await submission();

    const unauthorized = await client(async () =>
      jsonResponse(401, {
        error: { code: 'unauthorized', message: 'authorization failed' },
      }),
    ).submitRecord(outbound);
    const transport = await client(async () => {
      throw new Error('connection refused');
    }).submitRecord(outbound);

    expect(unauthorized.outcome).toBe('retry');
    expect(transport.outcome).toBe('retry');
  });

  it('rejects an outbound body larger than the ingest limit before sending', async () => {
    const outbound = await submission();
    const oversize = {
      ...outbound,
      envelope: {
        ...outbound.envelope,
        filler: 'x'.repeat(MAX_ORGANIZATION_RECORD_API_BODY_BYTES),
      },
    };
    let sent = false;

    const result = await client(async () => {
      sent = true;
      return jsonResponse(200, {});
    }).submitRecord(oversize);

    expect(sent).toBe(false);
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason_code: 'record_envelope_too_large',
    });
  });
});
