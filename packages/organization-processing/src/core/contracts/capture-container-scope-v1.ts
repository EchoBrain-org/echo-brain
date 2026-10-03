import { assertPlainContextObjectV1 } from './context-capture-v1.js';
import { assertCaptureTextV1, type ContextCaptureEnvelopeV2 } from './context-capture-v2.js';
import { parseCaptureSourceRefV1 } from './capture-source-ref-v1.js';

/** Authority-selected exact container mappings. No wildcard expansion or access grants. */
export interface CaptureContainerScopeV1 {
  readonly schema_version: 1;
  readonly organization_id: string;
  readonly mappings: readonly {
    readonly container_ref: string; readonly project_id: string;
    /** Stable installed source identity; implementation version does not change the container grant. */
    readonly adapter: { readonly adapter_id: string; readonly instance_id: string };
  }[];
}
export function assertCaptureProjectIdV1(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('Capture project is invalid');
}
export function assertCaptureContainerScopeV1(value: unknown): asserts value is CaptureContainerScopeV1 {
  assertPlainContextObjectV1(value, ['schema_version', 'organization_id', 'mappings'], 'Capture container scope');
  const scope = value as CaptureContainerScopeV1;
  assertCaptureTextV1(scope.organization_id, 'Container scope organization');
  if (scope.schema_version !== 1 || !Array.isArray(scope.mappings) || scope.mappings.length < 1 || scope.mappings.length > 100) throw new Error('Capture container scope exceeds its bound');
  const seen = new Set<string>();
  for (const mapping of scope.mappings) {
    assertPlainContextObjectV1(mapping, ['container_ref', 'project_id', 'adapter'], 'Capture container mapping');
    assertPlainContextObjectV1(mapping.adapter, ['adapter_id', 'instance_id'], 'Capture container adapter');
    assertCaptureTextV1(mapping.adapter.adapter_id, 'Container adapter ID');
    assertCaptureTextV1(mapping.adapter.instance_id, 'Container adapter instance');
    const ref = parseCaptureSourceRefV1(mapping.container_ref);
    assertCaptureProjectIdV1(mapping.project_id);
    if (ref.kind !== 'container' || seen.has(mapping.container_ref)) throw new Error('Capture container mapping is invalid or ambiguous');
    seen.add(mapping.container_ref);
  }
}
/** Mapping selects an ECHO project; current retention and processing authorization remain separate. */
export function resolveCaptureContainerV1(scope: CaptureContainerScopeV1, source: ContextCaptureEnvelopeV2): {
  readonly organization_id: string; readonly container_ref: string; readonly project_id: string;
} {
  assertCaptureContainerScopeV1(scope);
  const mapping = scope.mappings.find(entry => entry.container_ref === source.content.provenance.container_ref);
  if (mapping === undefined) throw new Error('Capture container is outside the configured scope');
  if (mapping.adapter.adapter_id !== source.item.adapter.adapter_id || mapping.adapter.instance_id !== source.item.adapter.instance_id) throw new Error('Capture adapter differs from its configured container mapping');
  return { organization_id: scope.organization_id, container_ref: mapping.container_ref, project_id: mapping.project_id };
}
