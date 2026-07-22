import { Buffer } from 'node:buffer';
import {
  assertFederationId,
  assertP256LowS,
  canonicalJson,
  canonicalSha256,
  verifyP256LowSSignature,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import { validateOrganizationAccessLeaseRequest } from '@echo-brain/organization-api';
import type { OrganizationAccessLeaseRequestV1 } from '@echo-brain/organization-api';
import {
  createOrganizationEnrollmentReceipt,
  createOrganizationInstallationAccessState,
  organizationAuthorityPublicKey,
  organizationEnrollmentGrantSha256,
  organizationEnrollmentReceiptSha256,
  organizationEnrollmentRequestSha256,
  validateOrganizationAuthorityDescriptor,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentRequest,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
  OrganizationMembershipTypeV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import {
  AuthorityOperationError,
  StaleAccessStateError,
} from '../domain/errors.js';
import {
  addMilliseconds,
  assertConfiguredLeaseTtl,
  assertConfiguredRequestAge,
  assertDisplayName,
  assertFreshAccessRequest,
  assertGrantLifetimeSeconds,
  assertMembershipType,
  assertRevocationReason,
  timestampMillis,
} from '../domain/rules.js';
import type {
  AuthorityReadTransaction,
  OrganizationAuthorityRepository,
  StoredAccessLeaseRequest,
  StoredAuthorityAccessState,
  StoredAuthorityEnrollment,
  StoredAuthorityMembership,
} from './ports/authority-repository.js';
import type {
  AuthorityClock,
  AuthorityIdentifierGenerator,
  EnrollmentGrantGenerator,
  OrganizationAuthoritySigner,
} from './ports/runtime-ports.js';

const MAX_TRANSITION_RETRIES = 16;

export interface IssuedEnrollmentGrant {
  authority_id: string;
  authority_pin_sha256: Sha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_grant: Uint8Array;
  issued_at: string;
  expires_at: string;
}

export interface CompletedEnrollment {
  enrollment_receipt: OrganizationEnrollmentReceiptV1;
  access_state: OrganizationInstallationAccessStateV1;
}

export interface RevokedMembershipResult {
  membership: StoredAuthorityMembership;
  installations: Array<{
    installation_id: string;
    access_state: OrganizationInstallationAccessStateV1;
  }>;
}

export interface CreateOrganizationAuthorityApplicationOptions {
  repository: OrganizationAuthorityRepository;
  signer: OrganizationAuthoritySigner;
  clock: AuthorityClock;
  identifiers: AuthorityIdentifierGenerator;
  grants: EnrollmentGrantGenerator;
  independently_trusted_authority_pin: Sha256Digest;
  organization_display_name: string;
  active_lease_ttl_ms: number;
  access_request_maximum_age_ms: number;
}

function sameDescriptor(
  left: OrganizationAuthorityDescriptorV1,
  right: OrganizationAuthorityDescriptorV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireCurrentAccessState(
  transaction: AuthorityReadTransaction,
  enrollmentId: string,
): StoredAuthorityAccessState {
  const state = transaction.currentAccessState(enrollmentId);
  if (state === undefined) {
    throw new Error('authority enrollment has no access-state high watermark');
  }
  return state;
}

function requireEnrollment(
  transaction: AuthorityReadTransaction,
  enrollmentId: string,
): StoredAuthorityEnrollment {
  const enrollment = transaction.enrollmentById(enrollmentId);
  if (enrollment === undefined) {
    throw new AuthorityOperationError('not_found', 'enrollment was not found');
  }
  return enrollment;
}

export class OrganizationAuthorityApplication {
  private constructor(
    private readonly repository: OrganizationAuthorityRepository,
    private readonly signer: OrganizationAuthoritySigner,
    private readonly clock: AuthorityClock,
    private readonly identifiers: AuthorityIdentifierGenerator,
    private readonly grants: EnrollmentGrantGenerator,
    private readonly descriptorValue: OrganizationAuthorityDescriptorV1,
    private readonly pinnedAuthority: PinnedOrganizationAuthority,
    private readonly activeLeaseTtlMs: number,
    private readonly accessRequestMaximumAgeMs: number,
  ) {}

  static async create(
    options: CreateOrganizationAuthorityApplicationOptions,
  ): Promise<OrganizationAuthorityApplication> {
    assertConfiguredLeaseTtl(options.active_lease_ttl_ms);
    assertConfiguredRequestAge(options.access_request_maximum_age_ms);
    assertDisplayName(options.organization_display_name);
    const descriptor = validateOrganizationAuthorityDescriptor(
      await options.signer.inspect(),
    );
    const pinnedAuthority = verifyOrganizationAuthorityPin(
      descriptor,
      options.independently_trusted_authority_pin,
    );
    const initializedAt = options.clock.now();
    timestampMillis(initializedAt, 'authority initialization time');
    options.repository.initialize({
      descriptor,
      authority_pin_sha256: options.independently_trusted_authority_pin,
      organization_display_name: options.organization_display_name,
      maximum_active_lease_ttl_ms: options.active_lease_ttl_ms,
      initialized_at: initializedAt,
    });
    return new OrganizationAuthorityApplication(
      options.repository,
      options.signer,
      options.clock,
      options.identifiers,
      options.grants,
      descriptor,
      pinnedAuthority,
      options.active_lease_ttl_ms,
      options.access_request_maximum_age_ms,
    );
  }

  descriptor(): OrganizationAuthorityDescriptorV1 {
    return JSON.parse(
      canonicalJson(this.descriptorValue),
    ) as OrganizationAuthorityDescriptorV1;
  }

  authorityPinSha256(): Sha256Digest {
    return this.pinnedAuthority.authority_pin_sha256;
  }

  close(): void {
    this.repository.close();
  }

  private now(label: string): string {
    const value = this.clock.now();
    timestampMillis(value, label);
    return value;
  }

  private async signCanonicalPayload(bytes: Buffer): Promise<Buffer> {
    const current = validateOrganizationAuthorityDescriptor(
      await this.signer.inspect(),
    );
    if (!sameDescriptor(current, this.descriptorValue)) {
      throw new Error('organization authority signer descriptor changed');
    }
    const message = Buffer.from(bytes);
    const signature = await this.signer.sign(
      Buffer.from(message),
      this.descriptorValue.signing_key.key_id,
    );
    assertP256LowS(signature);
    if (
      !verifyP256LowSSignature(
        organizationAuthorityPublicKey(this.pinnedAuthority),
        message,
        signature,
      )
    ) {
      throw new Error(
        'organization authority signer returned an invalid signature',
      );
    }
    return Buffer.from(signature);
  }

  provisionMembership(input: {
    display_name: string;
    membership_type: OrganizationMembershipTypeV1;
  }): StoredAuthorityMembership {
    assertDisplayName(input.display_name);
    assertMembershipType(input.membership_type);
    const provisionedAt = this.now('membership provisioning time');
    const principalId = this.identifiers.next('prn');
    const membershipId = this.identifiers.next('mem');
    assertFederationId(principalId, 'prn', 'generated principal_id');
    assertFederationId(membershipId, 'mem', 'generated membership_id');
    const membership: StoredAuthorityMembership = {
      organization_id: this.descriptorValue.organization_id,
      principal_id: principalId,
      membership_id: membershipId,
      display_name: input.display_name,
      membership_type: input.membership_type,
      status: 'active',
      provisioned_at: provisionedAt,
      revoked_at: null,
      revocation_reason: null,
    };
    return this.repository.write(provisionedAt, (transaction) => {
      transaction.insertMembership(membership);
      transaction.appendAudit({
        occurred_at: provisionedAt,
        actor_kind: 'admin',
        action: 'membership.provisioned',
        subject_id: membership.membership_id,
        detail: {
          membership_type: membership.membership_type,
          principal_id: membership.principal_id,
        },
      });
      return membership;
    });
  }

  issueEnrollmentGrant(
    membershipId: string,
    lifetimeSeconds: number,
  ): IssuedEnrollmentGrant {
    assertFederationId(membershipId, 'mem', 'enrollment grant membership');
    assertGrantLifetimeSeconds(lifetimeSeconds);
    const secret = this.grants.generate();
    if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
      throw new Error(
        'enrollment grant generator must return exactly 32 bytes',
      );
    }
    const secretSnapshot = Uint8Array.from(secret);
    const grantSha256 = organizationEnrollmentGrantSha256(secretSnapshot);
    const issuedAt = this.now('enrollment grant issue time');
    const expiresAt = addMilliseconds(issuedAt, lifetimeSeconds * 1000);
    return this.repository.write(issuedAt, (transaction) => {
      const membership = transaction.membership(membershipId);
      if (
        membership === undefined ||
        membership.organization_id !== this.descriptorValue.organization_id ||
        membership.status !== 'active'
      ) {
        throw new AuthorityOperationError(
          'not_found',
          'active membership was not found',
        );
      }
      transaction.insertGrant({
        grant_sha256: grantSha256,
        authority_id: this.descriptorValue.authority_id,
        organization_id: this.descriptorValue.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        issued_at: issuedAt,
        expires_at: expiresAt,
        consumed_at: null,
        request_sha256: null,
      });
      transaction.appendAudit({
        occurred_at: issuedAt,
        actor_kind: 'admin',
        action: 'enrollment_grant.issued',
        subject_id: membership.membership_id,
        detail: {
          expires_at: expiresAt,
          grant_sha256: grantSha256,
        },
      });
      return {
        authority_id: this.descriptorValue.authority_id,
        authority_pin_sha256: this.pinnedAuthority.authority_pin_sha256,
        organization_id: this.descriptorValue.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        enrollment_grant: secretSnapshot,
        issued_at: issuedAt,
        expires_at: expiresAt,
      };
    });
  }

  private existingEnrollmentResult(
    transaction: AuthorityReadTransaction,
    grantSha256: Sha256Digest,
    requestSha256: Sha256Digest,
  ): CompletedEnrollment | undefined {
    const grant = transaction.grant(grantSha256);
    if (grant?.consumed_at === null || grant === undefined) return undefined;
    if (grant.request_sha256 !== requestSha256) {
      throw new AuthorityOperationError(
        'unauthorized',
        'enrollment grant is unavailable',
      );
    }
    const enrollment = transaction.enrollmentByGrant(grantSha256);
    if (
      enrollment === undefined ||
      enrollment.request_sha256 !== requestSha256
    ) {
      throw new Error('stored enrollment result is inconsistent');
    }
    const initialState = transaction.accessState(enrollment.enrollment_id, 1);
    if (initialState === undefined) {
      throw new Error('stored enrollment initial access state is missing');
    }
    return {
      enrollment_receipt: enrollment.receipt,
      access_state: initialState.state,
    };
  }

  async completeEnrollment(input: {
    enrollment_grant: Uint8Array;
    enrollment_request: OrganizationEnrollmentRequestV1;
  }): Promise<CompletedEnrollment> {
    const grantSha256 = organizationEnrollmentGrantSha256(
      input.enrollment_grant,
    );
    let request: OrganizationEnrollmentRequestV1;
    try {
      request = verifyOrganizationEnrollmentRequest(
        input.enrollment_request,
        this.pinnedAuthority,
      );
    } catch {
      throw new AuthorityOperationError(
        'unauthorized',
        'enrollment request authentication failed',
      );
    }
    if (request.enrollment_grant_sha256 !== grantSha256) {
      throw new AuthorityOperationError(
        'unauthorized',
        'enrollment grant is unavailable',
      );
    }
    const requestSha256 = organizationEnrollmentRequestSha256(
      request,
      this.pinnedAuthority,
    );
    const existing = this.repository.read((transaction) =>
      this.existingEnrollmentResult(transaction, grantSha256, requestSha256),
    );
    if (existing !== undefined) return existing;

    const preparedAt = this.now('enrollment preparation time');
    const snapshot = this.repository.read((transaction) => {
      const grant = transaction.grant(grantSha256);
      const membership = transaction.membership(request.membership_id);
      if (
        grant === undefined ||
        grant.consumed_at !== null ||
        grant.authority_id !== request.authority_id ||
        grant.organization_id !== request.organization_id ||
        grant.principal_id !== request.principal_id ||
        grant.membership_id !== request.membership_id ||
        membership === undefined ||
        membership.status !== 'active' ||
        membership.principal_id !== request.principal_id ||
        preparedAt < grant.issued_at ||
        preparedAt >= grant.expires_at
      ) {
        throw new AuthorityOperationError(
          'unauthorized',
          'enrollment grant is unavailable',
        );
      }
      return { membership };
    });

    const enrollmentId = this.identifiers.next('enr');
    assertFederationId(enrollmentId, 'enr', 'generated enrollment_id');
    const receipt = await createOrganizationEnrollmentReceipt(
      {
        enrollment_id: enrollmentId,
        membership_type: snapshot.membership.membership_type,
        enrolled_at: preparedAt,
        request,
      },
      this.pinnedAuthority,
      (bytes) => this.signCanonicalPayload(bytes),
    );
    const receiptSha256 = organizationEnrollmentReceiptSha256(
      receipt,
      this.pinnedAuthority,
      request,
    );
    const initialState = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: null,
        access_state_sequence: 1,
        evaluated_at: preparedAt,
        status: 'active',
        valid_until: addMilliseconds(preparedAt, this.activeLeaseTtlMs),
        maximum_active_ttl_ms: this.activeLeaseTtlMs,
      },
      this.pinnedAuthority,
      (bytes) => this.signCanonicalPayload(bytes),
    );
    const initialStateSha256 = canonicalSha256(initialState);
    const candidate: StoredAuthorityEnrollment = {
      enrollment_id: enrollmentId,
      grant_sha256: grantSha256,
      request_sha256: requestSha256,
      request,
      receipt_sha256: receiptSha256,
      receipt,
      authority_id: request.authority_id,
      organization_id: request.organization_id,
      principal_id: request.principal_id,
      membership_id: request.membership_id,
      membership_type: snapshot.membership.membership_type,
      installation_id: request.installation_id,
      installation_signing_key: request.installation_signing_key,
      status: 'active',
      enrolled_at: preparedAt,
      revoked_at: null,
      revocation_kind: null,
      revocation_reason: null,
    };

    const commitAt = this.now('enrollment commit time');
    if (commitAt < preparedAt) {
      throw new Error('authority clock regressed while completing enrollment');
    }
    if (
      initialState.status !== 'active' ||
      commitAt >= initialState.valid_until
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'enrollment signing exceeded the initial access lease',
      );
    }
    return this.repository.write(commitAt, (transaction) => {
      const concurrent = this.existingEnrollmentResult(
        transaction,
        grantSha256,
        requestSha256,
      );
      if (concurrent !== undefined) return concurrent;
      const grant = transaction.grant(grantSha256);
      const membership = transaction.membership(request.membership_id);
      if (
        grant === undefined ||
        grant.consumed_at !== null ||
        commitAt < grant.issued_at ||
        commitAt >= grant.expires_at ||
        grant.authority_id !== request.authority_id ||
        grant.organization_id !== request.organization_id ||
        grant.principal_id !== request.principal_id ||
        grant.membership_id !== request.membership_id ||
        membership === undefined ||
        membership.status !== 'active' ||
        membership.principal_id !== request.principal_id ||
        membership.membership_type !== snapshot.membership.membership_type
      ) {
        throw new AuthorityOperationError(
          'unauthorized',
          'enrollment grant is unavailable',
        );
      }
      if (
        transaction.enrollmentByInstallation(request.installation_id) !==
          undefined ||
        transaction.enrollmentByKey(request.installation_signing_key.key_id) !==
          undefined ||
        transaction.enrollmentByRequest(requestSha256) !== undefined
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'installation identifier or signing key is already enrolled',
        );
      }
      transaction.insertEnrollment({
        enrollment: candidate,
        initial_access_state: {
          enrollment_id: enrollmentId,
          state_sha256: initialStateSha256,
          state: initialState,
        },
      });
      if (!transaction.consumeGrant(grantSha256, requestSha256, commitAt)) {
        throw new Error(
          'enrollment grant consumption lost its transaction race',
        );
      }
      transaction.appendAudit({
        occurred_at: commitAt,
        actor_kind: 'enrollment_grant',
        action: 'installation.enrolled',
        subject_id: request.installation_id,
        detail: {
          enrollment_id: enrollmentId,
          request_sha256: requestSha256,
        },
      });
      return {
        enrollment_receipt: receipt,
        access_state: initialState,
      };
    });
  }

  private authenticateAccessCommand(
    command: OrganizationAccessLeaseRequestV1,
    enrollment: StoredAuthorityEnrollment,
  ): Sha256Digest {
    if (
      command.authority_id !== enrollment.authority_id ||
      command.authority_key_id !== this.descriptorValue.signing_key.key_id ||
      command.organization_id !== enrollment.organization_id ||
      command.enrollment_id !== enrollment.enrollment_id ||
      command.installation_id !== enrollment.installation_id ||
      command.installation_key_id !== enrollment.installation_signing_key.key_id
    ) {
      throw new AuthorityOperationError(
        'unauthorized',
        'access lease request does not match the enrollment',
      );
    }
    try {
      const publicKey = verifyP256SigningKeyDescriptor(
        enrollment.installation_signing_key,
      );
      verifySignedDocument(
        command,
        publicKey,
        enrollment.installation_signing_key.key_id,
      );
    } catch {
      throw new AuthorityOperationError(
        'unauthorized',
        'access lease request authentication failed',
      );
    }
    return canonicalSha256(command);
  }

  private storedLeaseResponse(
    transaction: AuthorityReadTransaction,
    requestSha256: Sha256Digest,
    request: OrganizationAccessLeaseRequestV1,
  ): OrganizationInstallationAccessStateV1 | undefined {
    const stored = transaction.accessLeaseRequestByDigest(requestSha256);
    if (stored === undefined) return undefined;
    if (canonicalJson(stored.request) !== canonicalJson(request)) {
      throw new Error('stored access request digest is inconsistent');
    }
    const state = transaction.accessStateByDigest(
      stored.resulting_state_sha256,
    );
    if (state === undefined || state.enrollment_id !== stored.enrollment_id) {
      throw new Error('stored access request result is inconsistent');
    }
    return state.state;
  }

  async issueAccessLease(
    command: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationInstallationAccessStateV1> {
    command = validateOrganizationAccessLeaseRequest(command);
    command = JSON.parse(
      canonicalJson(command),
    ) as OrganizationAccessLeaseRequestV1;
    const enrollment = this.repository.read((transaction) =>
      requireEnrollment(transaction, command.enrollment_id),
    );
    const requestSha256 = this.authenticateAccessCommand(command, enrollment);
    const replay = this.repository.read((transaction) =>
      this.storedLeaseResponse(transaction, requestSha256, command),
    );
    if (replay !== undefined) return replay;
    const requestedAt = this.now('access lease request receipt time');
    assertFreshAccessRequest(
      command.requested_at,
      requestedAt,
      this.accessRequestMaximumAgeMs,
    );

    const snapshot = this.repository.read((transaction) => {
      const currentEnrollment = requireEnrollment(
        transaction,
        command.enrollment_id,
      );
      const duplicateId = transaction.accessLeaseRequestById(
        command.enrollment_id,
        command.request_id,
      );
      if (
        duplicateId !== undefined &&
        duplicateId.request_sha256 !== requestSha256
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'access request_id was reused with different content',
        );
      }
      const namedPrevious = transaction.accessStateByDigest(
        command.previous_access_state_sha256,
      );
      if (
        namedPrevious === undefined ||
        namedPrevious.enrollment_id !== currentEnrollment.enrollment_id
      ) {
        throw new AuthorityOperationError(
          'unauthorized',
          'access lease request names an unknown previous state',
        );
      }
      return {
        enrollment: currentEnrollment,
        membership: transaction.membership(currentEnrollment.membership_id),
        current: requireCurrentAccessState(
          transaction,
          currentEnrollment.enrollment_id,
        ),
      };
    });
    if (snapshot.enrollment.status === 'active') {
      if (
        snapshot.membership === undefined ||
        snapshot.membership.status !== 'active'
      ) {
        throw new Error('active enrollment has no active membership');
      }
      if (
        command.previous_access_state_sha256 !== snapshot.current.state_sha256
      ) {
        throw new StaleAccessStateError(snapshot.current.state);
      }
    }

    let candidate: StoredAuthorityAccessState | undefined;
    if (snapshot.enrollment.status === 'active') {
      const state = await createOrganizationInstallationAccessState(
        {
          request: snapshot.enrollment.request,
          receipt: snapshot.enrollment.receipt,
          previous_state: snapshot.current.state,
          access_state_sequence:
            snapshot.current.state.access_state_sequence + 1,
          evaluated_at: requestedAt,
          status: 'active',
          valid_until: addMilliseconds(requestedAt, this.activeLeaseTtlMs),
          maximum_active_ttl_ms: this.activeLeaseTtlMs,
        },
        this.pinnedAuthority,
        (bytes) => this.signCanonicalPayload(bytes),
      );
      candidate = {
        enrollment_id: snapshot.enrollment.enrollment_id,
        state_sha256: canonicalSha256(state),
        state,
      };
    }

    const commitAt = this.now('access lease commit time');
    if (commitAt < requestedAt) {
      throw new Error('authority clock regressed while issuing access lease');
    }
    if (
      candidate?.state.status === 'active' &&
      commitAt >= candidate.state.valid_until
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'access-state signing exceeded the active lease',
      );
    }
    return this.repository.write(commitAt, (transaction) => {
      const exact = this.storedLeaseResponse(
        transaction,
        requestSha256,
        command,
      );
      if (exact !== undefined) return exact;
      const duplicateId = transaction.accessLeaseRequestById(
        command.enrollment_id,
        command.request_id,
      );
      if (duplicateId !== undefined) {
        throw new AuthorityOperationError(
          'conflict',
          'access request_id was reused with different content',
        );
      }
      const currentEnrollment = requireEnrollment(
        transaction,
        command.enrollment_id,
      );
      const current = requireCurrentAccessState(
        transaction,
        command.enrollment_id,
      );
      let resulting = current;
      if (currentEnrollment.status === 'active') {
        const membership = transaction.membership(
          currentEnrollment.membership_id,
        );
        if (membership === undefined || membership.status !== 'active') {
          throw new Error('active enrollment has no active membership');
        }
        if (current.state_sha256 !== command.previous_access_state_sha256) {
          throw new StaleAccessStateError(current.state);
        }
        if (candidate === undefined) {
          throw new Error('active access lease candidate is unavailable');
        }
        transaction.insertAccessState(candidate);
        resulting = candidate;
      }
      const requestRecord: StoredAccessLeaseRequest = {
        request_id: command.request_id,
        request_sha256: requestSha256,
        request: command,
        enrollment_id: command.enrollment_id,
        previous_access_state_sha256: command.previous_access_state_sha256,
        resulting_state_sha256: resulting.state_sha256,
        received_at: commitAt,
      };
      transaction.insertAccessLeaseRequest(requestRecord);
      transaction.appendAudit({
        occurred_at: commitAt,
        actor_kind: 'installation',
        action:
          resulting.state.status === 'active'
            ? 'access_lease.issued'
            : 'access_lease.revoked_state_returned',
        subject_id: currentEnrollment.installation_id,
        detail: {
          request_id: command.request_id,
          access_state_sequence: resulting.state.access_state_sequence,
        },
      });
      return resulting.state;
    });
  }

  async revokeInstallation(
    installationId: string,
    reason: string,
  ): Promise<OrganizationInstallationAccessStateV1> {
    assertFederationId(installationId, 'ins', 'revoked installation');
    assertRevocationReason(reason);
    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
      const snapshot = this.repository.read((transaction) => {
        const enrollment = transaction.enrollmentByInstallation(installationId);
        if (enrollment === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'installation was not found',
          );
        }
        return {
          enrollment,
          current: requireCurrentAccessState(
            transaction,
            enrollment.enrollment_id,
          ),
        };
      });
      if (snapshot.enrollment.status === 'revoked') {
        return snapshot.current.state;
      }
      const evaluatedAt = this.now('installation revocation time');
      const state = await createOrganizationInstallationAccessState(
        {
          request: snapshot.enrollment.request,
          receipt: snapshot.enrollment.receipt,
          previous_state: snapshot.current.state,
          access_state_sequence:
            snapshot.current.state.access_state_sequence + 1,
          evaluated_at: evaluatedAt,
          status: 'revoked',
          revocation_reason: 'installation_revoked',
        },
        this.pinnedAuthority,
        (bytes) => this.signCanonicalPayload(bytes),
      );
      const candidate: StoredAuthorityAccessState = {
        enrollment_id: snapshot.enrollment.enrollment_id,
        state_sha256: canonicalSha256(state),
        state,
      };
      const commitAt = this.now('installation revocation commit time');
      if (commitAt < evaluatedAt) {
        throw new Error(
          'authority clock regressed while revoking installation',
        );
      }
      const result = this.repository.write(commitAt, (transaction) => {
        const enrollment = transaction.enrollmentByInstallation(installationId);
        if (enrollment === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'installation was not found',
          );
        }
        const current = requireCurrentAccessState(
          transaction,
          enrollment.enrollment_id,
        );
        if (enrollment.status === 'revoked') return current.state;
        if (current.state_sha256 !== snapshot.current.state_sha256) return null;
        transaction.insertAccessState(candidate);
        if (
          !transaction.revokeEnrollment(
            enrollment.enrollment_id,
            commitAt,
            'installation_revoked',
            reason,
          )
        ) {
          throw new Error(
            'installation enrollment changed inside its revocation transaction',
          );
        }
        transaction.appendAudit({
          occurred_at: commitAt,
          actor_kind: 'admin',
          action: 'installation.revoked',
          subject_id: installationId,
          detail: { reason },
        });
        return state;
      });
      if (result !== null) return result;
    }
    throw new AuthorityOperationError(
      'conflict',
      'installation revocation could not serialize',
    );
  }

  async revokeMembership(
    membershipId: string,
    reason: string,
  ): Promise<RevokedMembershipResult> {
    assertFederationId(membershipId, 'mem', 'revoked membership');
    assertRevocationReason(reason);
    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
      const snapshot = this.repository.read((transaction) => {
        const membership = transaction.membership(membershipId);
        if (membership === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'membership was not found',
          );
        }
        const enrollments = transaction.enrollmentsForMembership(membershipId);
        return {
          membership,
          enrollments: enrollments.map((enrollment) => ({
            enrollment,
            current: requireCurrentAccessState(
              transaction,
              enrollment.enrollment_id,
            ),
          })),
        };
      });
      if (snapshot.membership.status === 'revoked') {
        return {
          membership: snapshot.membership,
          installations: snapshot.enrollments.map(
            ({ enrollment, current }) => ({
              installation_id: enrollment.installation_id,
              access_state: current.state,
            }),
          ),
        };
      }
      const evaluatedAt = this.now('membership revocation time');
      const candidates = new Map<string, StoredAuthorityAccessState>();
      for (const { enrollment, current } of snapshot.enrollments) {
        if (enrollment.status === 'revoked') continue;
        const state = await createOrganizationInstallationAccessState(
          {
            request: enrollment.request,
            receipt: enrollment.receipt,
            previous_state: current.state,
            access_state_sequence: current.state.access_state_sequence + 1,
            evaluated_at: evaluatedAt,
            status: 'revoked',
            revocation_reason: 'membership_revoked',
          },
          this.pinnedAuthority,
          (bytes) => this.signCanonicalPayload(bytes),
        );
        candidates.set(enrollment.enrollment_id, {
          enrollment_id: enrollment.enrollment_id,
          state_sha256: canonicalSha256(state),
          state,
        });
      }
      const commitAt = this.now('membership revocation commit time');
      if (commitAt < evaluatedAt) {
        throw new Error('authority clock regressed while revoking membership');
      }
      const result = this.repository.write(commitAt, (transaction) => {
        const membership = transaction.membership(membershipId);
        if (membership === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'membership was not found',
          );
        }
        if (membership.status === 'revoked') return null;
        const currentEnrollments =
          transaction.enrollmentsForMembership(membershipId);
        if (
          currentEnrollments.length !== snapshot.enrollments.length ||
          currentEnrollments.some(
            (enrollment, index) =>
              enrollment.enrollment_id !==
              snapshot.enrollments[index]?.enrollment.enrollment_id,
          )
        ) {
          return null;
        }
        for (const item of snapshot.enrollments) {
          const enrollment = transaction.enrollmentById(
            item.enrollment.enrollment_id,
          );
          const current = requireCurrentAccessState(
            transaction,
            item.enrollment.enrollment_id,
          );
          if (
            enrollment === undefined ||
            enrollment.status !== item.enrollment.status ||
            current.state_sha256 !== item.current.state_sha256
          ) {
            return null;
          }
        }
        if (!transaction.revokeMembership(membershipId, commitAt, reason)) {
          return null;
        }
        for (const item of snapshot.enrollments) {
          if (item.enrollment.status === 'revoked') continue;
          const candidate = candidates.get(item.enrollment.enrollment_id);
          if (candidate === undefined) {
            throw new Error('membership revocation candidate is unavailable');
          }
          transaction.insertAccessState(candidate);
          if (
            !transaction.revokeEnrollment(
              item.enrollment.enrollment_id,
              commitAt,
              'membership_revoked',
              reason,
            )
          ) {
            throw new Error(
              'membership enrollment revocation lost its transaction race',
            );
          }
        }
        transaction.appendAudit({
          occurred_at: commitAt,
          actor_kind: 'admin',
          action: 'membership.revoked',
          subject_id: membershipId,
          detail: { reason },
        });
        const storedMembership = transaction.membership(membershipId);
        if (storedMembership === undefined) {
          throw new Error('revoked membership disappeared');
        }
        return {
          membership: storedMembership,
          installations: transaction
            .enrollmentsForMembership(membershipId)
            .map((enrollment) => ({
              installation_id: enrollment.installation_id,
              access_state: requireCurrentAccessState(
                transaction,
                enrollment.enrollment_id,
              ).state,
            })),
        };
      });
      if (result !== null) return result;
    }
    throw new AuthorityOperationError(
      'conflict',
      'membership revocation could not serialize',
    );
  }
}
