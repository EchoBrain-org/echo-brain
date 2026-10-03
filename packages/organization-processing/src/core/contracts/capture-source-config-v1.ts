import { assertPlainContextObjectV1 } from './context-capture-v1.js';
import { assertCaptureTextV1 } from './context-capture-v2.js';
import { assertCaptureContainerScopeV1, type CaptureContainerScopeV1 } from './capture-container-scope-v1.js';
import { assertSourceAdmissionScopeV1, sourceContentSha256V1 } from '../processing/source-admission.js';
import type { SourceAdapterIdentityV1, SourceAdmissionScopeV1 } from './source.js';

/** Canonical order. A configuration lists a subset in this order, so one policy has one digest. */
export const CAPTURE_REPRESENTATION_KINDS_V1 = Object.freeze(['pointer', 'excerpt', 'full_snapshot'] as const);
export type CaptureRepresentationKindV1 = typeof CAPTURE_REPRESENTATION_KINDS_V1[number];

/**
 * One connected source, as data. The adapter ID selects provider code; nothing else
 * here is vendor-specific. The configuration is policy input, not a continuing grant.
 */
export interface CaptureSourceConfigV1 {
  readonly schema_version: 1;
  /** ECHO's identifier for this connected source. It also keys the source's bookmark. */
  readonly source_id: string;
  /** Must equal the provider's identity exactly. */
  readonly adapter: SourceAdapterIdentityV1;
  readonly scope: SourceAdmissionScopeV1;
  /** Exact container_ref to project mappings for this adapter. */
  readonly containers: CaptureContainerScopeV1;
  /** Request-only sources stay on the live-reader path and never enter capture. */
  readonly disposition: 'retained';
  readonly representations: readonly CaptureRepresentationKindV1[];
  /** Names a local rule set. Its producer config_sha256 is this configuration's digest. */
  readonly classifier: { readonly id: string; readonly version: string };
}

export function assertCaptureSourceConfigV1(value: unknown): asserts value is CaptureSourceConfigV1 {
  assertPlainContextObjectV1(value, ['schema_version', 'source_id', 'adapter', 'scope', 'containers', 'disposition', 'representations', 'classifier'], 'Capture source config');
  const config = value as CaptureSourceConfigV1;
  if (config.schema_version !== 1 || config.disposition !== 'retained') throw new Error('Capture source config version or disposition is unsupported');
  assertCaptureTextV1(config.source_id, 'Capture source ID', 256);
  assertPlainContextObjectV1(config.adapter, ['kind', 'adapter_id', 'instance_id', 'version'], 'Capture source adapter');
  if (config.adapter.kind !== 'source') throw new Error('Capture source adapter must be a source adapter');
  assertCaptureTextV1(config.adapter.adapter_id, 'Capture adapter ID'); assertCaptureTextV1(config.adapter.instance_id, 'Capture adapter instance');
  assertCaptureTextV1(config.adapter.version, 'Capture adapter version');
  assertSourceAdmissionScopeV1(config.scope);
  // Capture never enables automatic analysis.
  if (config.scope.analysis_policy !== 'on_request') throw new Error('Capture source analysis must be on request');
  assertCaptureContainerScopeV1(config.containers);
  if (config.containers.organization_id !== config.scope.organization_id ||
      config.containers.mappings.some(mapping => mapping.adapter.adapter_id !== config.adapter.adapter_id || mapping.adapter.instance_id !== config.adapter.instance_id)) {
    throw new Error('Capture source containers differ from its organization or adapter');
  }
  const order: readonly unknown[] = CAPTURE_REPRESENTATION_KINDS_V1;
  const kinds = config.representations as readonly unknown[];
  if (!Array.isArray(kinds) || kinds.length < 1 ||
      kinds.some((kind, index) => !order.includes(kind) || (index > 0 && order.indexOf(kind) <= order.indexOf(kinds[index - 1])))) {
    throw new Error('Capture source representations must be known, unique and in canonical order');
  }
  assertPlainContextObjectV1(config.classifier, ['id', 'version'], 'Capture source classifier');
  assertCaptureTextV1(config.classifier.id, 'Capture classifier ID'); assertCaptureTextV1(config.classifier.version, 'Capture classifier version');
}

/** Digest of the whole configuration. Key order is immaterial; any policy change changes it. */
export function captureSourceConfigSha256V1(config: CaptureSourceConfigV1): string {
  assertCaptureSourceConfigV1(config);
  return sourceContentSha256V1(config);
}
