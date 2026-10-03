import {
  assertCaptureSourceConfigV1, canonicalSourceContentV1, resolveCaptureContainerV1,
  type CapturePersonBindingV1, type CaptureSourceConfigV1, type ContextCaptureEnvelopeV2, type SourceArtifactReferenceV1,
} from '@echo-brain/organization-processing/core';
import { snapshotCaptureDataV1, type CaptureFoundationAuthorityV1 } from './capture-foundation-v1.js';

type CaptureOperationV1 = Parameters<CaptureFoundationAuthorityV1['requireCurrent']>[0]['operation'];
function witnessed(answer: unknown): boolean {
  // A late answer cannot authorize a check that already had to complete.
  if (answer instanceof Promise) void answer.catch(() => undefined);
  return answer === true;
}

/** Injected Authority witnesses. Each must answer synchronously with exactly `true`; anything else denies. */
export interface CaptureSourceAuthorityCheckersV1 {
  readonly identity_link?: (input: {
    readonly operation: CaptureOperationV1; readonly source: ContextCaptureEnvelopeV2; readonly binding: CapturePersonBindingV1;
  }) => boolean;
  readonly artifact_custody?: (input: {
    readonly operation: CaptureOperationV1; readonly source: ContextCaptureEnvelopeV2; readonly artifact: SourceArtifactReferenceV1;
  }) => boolean;
}

/**
 * The current-policy fence for one configured source, built from its configuration row.
 * The row is the whole grant: it cannot widen scope, representation or identity.
 * Retention requires the configured adapter version; historical derive reads accept
 * revisions captured by an earlier version of the same installed adapter.
 * It does not yet reject withdrawn inputs (ADR-0029), such as an earlier revision of an
 * item whose retained head is a tombstone; that remains a gate on provider activation.
 */
export function createCaptureSourceAuthorityV1(config: CaptureSourceConfigV1, checkers: CaptureSourceAuthorityCheckersV1 = {}): CaptureFoundationAuthorityV1 {
  assertCaptureSourceConfigV1(config);
  const policy = snapshotCaptureDataV1(config);
  const scope = canonicalSourceContentV1(policy.scope);
  const { identity_link: identityLink, artifact_custody: artifactCustody } = checkers;
  return Object.freeze({
    requireCurrent({ operation, source, bindings }: Parameters<CaptureFoundationAuthorityV1['requireCurrent']>[0]): void {
      const adapter = source.item.adapter;
      if (adapter.kind !== policy.adapter.kind || adapter.adapter_id !== policy.adapter.adapter_id || adapter.instance_id !== policy.adapter.instance_id ||
          (operation === 'retain' && adapter.version !== policy.adapter.version)) throw new Error('Capture adapter differs from its source configuration');
      if (canonicalSourceContentV1(bindings.scope) !== scope) throw new Error('Capture scope differs from its source configuration');
      const mapping = resolveCaptureContainerV1(policy.containers, source);
      if (mapping.organization_id !== bindings.scope.organization_id || mapping.project_id !== bindings.project_id ||
          mapping.container_ref !== bindings.container_ref) throw new Error('Capture project differs from its source configuration');
      if (source.content.lifecycle === 'present' && !policy.representations.includes(source.content.representation.kind)) {
        throw new Error('Capture representation is not permitted for this source');
      }
      for (const binding of bindings.people) {
        if (!witnessed(identityLink?.({ operation, source, binding }))) throw new Error('Capture Person binding is not verified');
      }
      for (const artifact of source.revision.artifact_refs) {
        if (!witnessed(artifactCustody?.({ operation, source, artifact }))) throw new Error('Capture original artifact custody is not accepted');
      }
    },
  });
}
