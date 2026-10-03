import { describe, expect, it } from 'vitest';
import {
  assertCaptureSourceConfigV1, buildContextCaptureEnvelopeV2, captureSourceConfigSha256V1, captureSourcePullRequestV2, classifyCaptureV1,
  ownCaptureSourceBatchV2, CAPTURE_DEFAULT_CLASSIFIER_V1, type CaptureLocalRuleV1, type CaptureSourceConfigV1,
} from '../../src/core/index.js';
import {
  FAKE_CONTAINERS, FAKE_CONTENT, FAKE_CURSORS, FAKE_IDENTITY, FAKE_TIMES, fakeCaptureSourceConfig, fakeInitialItems,
} from '../../../../tests/support/capture-fake-provider-v2.js';

const request = captureSourcePullRequestV2({ limit: 10 });
const producer = { id: 'rules', version: '1', config_sha256: 'c'.repeat(64) };
function source(external_id: string, content = fakeInitialItems().find(item => item.external_id === external_id)!.content) {
  return buildContextCaptureEnvelopeV2({ identity: FAKE_IDENTITY, external_id, captured_at: FAKE_TIMES.first, content });
}

describe('capture source configuration', () => {
  it('accepts a closed configuration and digests it independently of key order', () => {
    const config = fakeCaptureSourceConfig();
    expect(() => assertCaptureSourceConfigV1(config)).not.toThrow();
    const reordered = Object.fromEntries(Object.entries(config).reverse()) as unknown as CaptureSourceConfigV1;
    expect(captureSourceConfigSha256V1(reordered)).toBe(captureSourceConfigSha256V1(config));
    expect(captureSourceConfigSha256V1(fakeCaptureSourceConfig({ representations: ['pointer'] }))).not.toBe(captureSourceConfigSha256V1(config));
  });
  it.each<[string, Record<string, unknown>]>([
    ['unknown field', { schedule: 'hourly' }],
    ['request-only disposition', { disposition: 'request_only' }],
    ['automatic analysis', { scope: { ...fakeCaptureSourceConfig().scope, analysis_policy: 'automatic' } }],
    ['meeting-source adapter', { adapter: { ...FAKE_IDENTITY, kind: 'meeting-source' } }],
    ['empty representations', { representations: [] }],
    ['unknown representation', { representations: ['raw_body'] }],
    ['duplicate representation', { representations: ['pointer', 'pointer'] }],
    ['non-canonical representation order', { representations: ['full_snapshot', 'pointer'] }],
    ['blank source ID', { source_id: ' ' }],
    ['other organization containers', { containers: { ...fakeCaptureSourceConfig().containers, organization_id: 'org_other' } }],
    ['container mapped to another adapter', { containers: { ...fakeCaptureSourceConfig().containers, mappings: [{
      container_ref: FAKE_CONTAINERS.alpha, project_id: 'prj_11111111-1111-4111-8111-111111111111', adapter: { adapter_id: FAKE_IDENTITY.adapter_id, instance_id: 'other' } }] } }],
    ['classifier with extra fields', { classifier: { id: 'rules', version: '1', config_sha256: 'c'.repeat(64) } }],
  ])('rejects %s', (_name, change) => {
    expect(() => assertCaptureSourceConfigV1({ ...fakeCaptureSourceConfig(), ...change })).toThrow();
  });
});

describe('capture source batches', () => {
  it('bounds pull requests', () => {
    expect(captureSourcePullRequestV2({ limit: 1, cursor: FAKE_CURSORS.first })).toEqual({ limit: 1, cursor: FAKE_CURSORS.first });
    for (const limit of [0, 101, 1.5]) expect(() => captureSourcePullRequestV2({ limit })).toThrow(/limit/);
    for (const cursor of ['', 'x'.repeat(16 * 1024 + 1)]) expect(() => captureSourcePullRequestV2({ limit: 1, cursor })).toThrow(/cursor/);
  });
  it('returns a frozen copy the provider can no longer change', () => {
    const returned = { items: fakeInitialItems(), next_cursor: FAKE_CURSORS.first };
    const owned = ownCaptureSourceBatchV2(returned, request);
    (returned.items[0] as { external_id: string }).external_id = 'changed-later';
    expect(owned.items[0]!.external_id).toBe('ticket-1'); expect(owned.items).toHaveLength(5);
    expect(Object.isFrozen(owned.items[0]!.content)).toBe(true); expect(owned.next_cursor).toBe(FAKE_CURSORS.first);
  });
  it.each<[string, () => unknown]>([
    ['more items than requested', () => ({ items: fakeInitialItems(), next_cursor: 'x' })],
    ['an unknown batch field', () => ({ items: [], envelopes: [] })],
    ['an unknown item field', () => ({ items: [{ ...fakeInitialItems()[0]!, previous_revision_id: 'context:x' }] })],
    ['an accessor field', () => ({ items: [Object.defineProperty({ captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.note() }, 'external_id', { get: () => 'note-1', enumerable: true })] })],
    ['a non-canonical observation time', () => ({ items: [{ ...fakeInitialItems()[0]!, captured_at: '2026-10-03T00:00:00Z' }] })],
    ['a blank external ID', () => ({ items: [{ ...fakeInitialItems()[0]!, external_id: ' ' }] })],
    ['oversized content', () => ({ items: [{ ...fakeInitialItems()[0]!, content: { ...FAKE_CONTENT.note(), label: 'x'.repeat(300 * 1024) } }] })],
    ['an oversized cursor', () => ({ items: [], next_cursor: 'x'.repeat(16 * 1024 + 1) })],
    ['an empty cursor', () => ({ items: [], next_cursor: '' })],
    ['a non-object batch', () => [fakeInitialItems()[0]]],
    ['a repeated item', () => ({ items: [fakeInitialItems()[0]!, { ...fakeInitialItems()[0]!, captured_at: FAKE_TIMES.second }] })],
  ])('rejects %s', (_name, batch) => {
    expect(() => ownCaptureSourceBatchV2(batch(), captureSourcePullRequestV2({ limit: 2 }))).toThrow();
  });
});

describe('local capture classification', () => {
  it('retains every valid present capture and every explicit tombstone by default', () => {
    for (const item of fakeInitialItems()) {
      expect(classifyCaptureV1({ source: source(item.external_id), producer, rules: CAPTURE_DEFAULT_CLASSIFIER_V1.rules })).toMatchObject({ method: 'local_rules', decision: 'retain', reason: 'useful', producer });
    }
    const deleted = buildContextCaptureEnvelopeV2({ identity: FAKE_IDENTITY, external_id: 'note-1', captured_at: FAKE_TIMES.second,
      content: FAKE_CONTENT.tombstone('note-1', FAKE_CONTAINERS.beta), previous: source('note-1') });
    const skipAll: CaptureLocalRuleV1 = () => ({ decision: 'skip', reason: 'noise' });
    expect(classifyCaptureV1({ source: deleted, producer, rules: [skipAll] })).toMatchObject({ decision: 'retain', reason: 'source_deleted' });
  });
  it('lets kind-based rules skip or defer, first match first', () => {
    const rules: CaptureLocalRuleV1[] = [
      content => content.payload.kind === 'note' ? { decision: 'skip', reason: 'noise' } : undefined,
      content => content.payload.kind === 'meeting' || content.payload.kind === 'note' ? { decision: 'unresolved', reason: 'needs_review' } : undefined,
    ];
    expect(classifyCaptureV1({ source: source('note-1'), producer, rules })).toMatchObject({ decision: 'skip', reason: 'noise' });
    expect(classifyCaptureV1({ source: source('meeting-1'), producer, rules })).toMatchObject({ decision: 'unresolved', reason: 'needs_review' });
    expect(classifyCaptureV1({ source: source('ticket-1'), producer, rules })).toMatchObject({ decision: 'retain', reason: 'useful' });
  });
  it('rejects asynchronous or out-of-contract rule answers', () => {
    const late = (() => Promise.resolve({ decision: 'skip', reason: 'noise' })) as unknown as CaptureLocalRuleV1;
    expect(() => classifyCaptureV1({ source: source('ticket-1'), producer, rules: [late] })).toThrow(/synchronously/);
    const wrong = (() => ({ decision: 'skip', reason: 'needs_review' })) as unknown as CaptureLocalRuleV1;
    expect(() => classifyCaptureV1({ source: source('ticket-1'), producer, rules: [wrong] })).toThrow(/Classification/);
  });
});
