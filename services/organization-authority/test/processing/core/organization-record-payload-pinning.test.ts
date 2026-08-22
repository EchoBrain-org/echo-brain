// The organization record payload schema restates the DecisionBrief shape core
// validates, because core imports no packages by design. The two are pinned
// together by this shared golden fixture rather than by shared code: the
// organization-protocol suite runs the same cases against its own validator,
// and any divergence fails on one side or the other.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertCanonicalDecisionBrief } from '../../../src/processing/core/index.js';

interface PayloadConformanceFixture {
  fixture_version: number;
  kind: string;
  valid: { name: string; brief: unknown }[];
  invalid: { name: string; reason: string; brief: unknown }[];
  record_only_invalid: {
    name: string;
    reason: string;
    core_accepts: boolean;
    brief: unknown;
  }[];
}

const conformance = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../packages/organization-protocol/fixtures/organization-record-payload-conformance.v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as PayloadConformanceFixture;

describe('organization record payload fixture pins core', () => {
  it('reads the versioned shared fixture', () => {
    expect(conformance.fixture_version).toBe(1);
    expect(conformance.kind).toBe(
      'echo-organization-record-payload-conformance-fixture',
    );
    expect(conformance.valid.length).toBeGreaterThan(0);
    expect(conformance.invalid.length).toBeGreaterThan(0);
  });

  it('accepts every brief the organization record contract accepts', () => {
    for (const testCase of conformance.valid) {
      expect(
        () => assertCanonicalDecisionBrief(testCase.brief),
        testCase.name,
      ).not.toThrow();
    }
  });

  it('rejects every brief the organization record contract rejects', () => {
    for (const testCase of conformance.invalid) {
      expect(
        () => assertCanonicalDecisionBrief(testCase.brief),
        `${testCase.name}: ${testCase.reason}`,
      ).toThrow();
    }
  });

  // The organization record contract is deliberately stricter than core in a
  // small, enumerated set of cases. Asserting that core still accepts them
  // keeps the divergence a tested fact instead of a comment that can rot: if
  // core ever tightens here, this fails and the fixture must move the case
  // into `invalid`.
  it('still accepts the enumerated record-only rejections', () => {
    expect(conformance.record_only_invalid.length).toBeGreaterThan(0);
    for (const testCase of conformance.record_only_invalid) {
      expect(testCase.core_accepts, testCase.name).toBe(true);
      expect(
        () => assertCanonicalDecisionBrief(testCase.brief),
        `${testCase.name}: ${testCase.reason}`,
      ).not.toThrow();
    }
  });
});
