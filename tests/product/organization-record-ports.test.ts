import { describe, expect, it } from 'vitest';
import type { SignedIntegrity } from '@echo-brain/federation-protocol';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
import type {
  DecisionNodeState,
  DecisionOrganizationRecordEnvelopeEvent,
  DecisionOrganizationRecordReceipt,
  DecisionOrganizationRecordReceiptIntegrity,
  DecisionSourceLocator,
} from '../../src/product/approval/decision-node.js';
import type { OrganizationApprovalActionAuthorizationResult } from '../../src/product/organization/approval-action-authorizer.js';
import type {
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordCandidateNode,
  OrganizationRecordFrozenEnvelope,
  OrganizationRecordNodeStore,
  OrganizationRecordReceiptIntegrity,
  OrganizationRecordSourceLocator,
  VerifiedOrganizationRecordReceipt,
} from '../../src/product/organization/record/index.js';

/** The exact evidence shape an allow decision stores on the resolved slot. */
type AllowEvidence = Extract<
  OrganizationApprovalActionAuthorizationResult,
  { allowed: true }
>['evidence'];

/**
 * The durable organization-record shapes are restated in three places by
 * design: the approval layer owns local slot state, the record module owns the
 * ports, and neither may import the other. These assignments are the pin --
 * a divergence between the restatements fails `tsc`, not a runtime assertion.
 *
 * The same discipline the design applies to the payload schema (restated
 * against core's `DecisionBrief`, pinned by fixtures rather than shared code)
 * applies here.
 */
function pin<T>(_value: T): void {
  /* type-level assertion only */
}

describe('organization record ports', () => {
  it('keeps DecisionNodeStore structurally usable as the injected node store port', () => {
    // If the store's method shapes drift from the port, this fails to compile.
    const store: OrganizationRecordNodeStore =
      new DecisionNodeStore('/tmp/echo-brain-unused');
    expect(typeof store.listForSubmission).toBe('function');
    expect(typeof store.createOrganizationRecordEnvelope).toBe('function');
    expect(typeof store.recordOrganizationRecordReceipt).toBe('function');
    expect(typeof store.recordOrganizationRecordRejection).toBe('function');
  });

  it('keeps the durable node state assignable to the submitter candidate port', () => {
    pin<(state: DecisionNodeState) => OrganizationRecordCandidateNode>(
      (state) => state,
    );
    pin<(locator: DecisionSourceLocator) => OrganizationRecordSourceLocator>(
      (locator) => locator,
    );
    pin<
      (
        envelope: DecisionOrganizationRecordEnvelopeEvent,
      ) => OrganizationRecordFrozenEnvelope
    >((envelope) => envelope);
    expect(true).toBe(true);
  });

  it('keeps the receipt and authorization evidence restatements interchangeable', () => {
    // A verified receipt must be filable through the durable store, and the
    // durable receipt must satisfy the port: both directions are pinned.
    pin<
      (
        receipt: VerifiedOrganizationRecordReceipt,
      ) => DecisionOrganizationRecordReceipt
    >((receipt) => receipt);
    pin<
      (
        receipt: DecisionOrganizationRecordReceipt,
      ) => VerifiedOrganizationRecordReceipt
    >((receipt) => receipt);
    // The exact allow-branch evidence the Slack surface stores must satisfy
    // what ingest requires -- whole, not a subset. If the authorizer ever drops
    // a field the record port needs, this fails to compile.
    pin<(allowed: AllowEvidence) => OrganizationRecordAuthorizationEvidence>(
      (allowed) => allowed,
    );
    // The shared signed-document integrity block must satisfy the port's
    // restatement, so a real signed receipt is filable as durable state.
    pin<
      (integrity: SignedIntegrity) => OrganizationRecordReceiptIntegrity
    >((integrity) => integrity);
    pin<
      (
        integrity: DecisionOrganizationRecordReceiptIntegrity,
      ) => OrganizationRecordReceiptIntegrity
    >((integrity) => integrity);
    expect(true).toBe(true);
  });
});
