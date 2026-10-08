import { describe, expect, it } from 'vitest';
import { APPROVAL_OWNER_MAX_CHARACTERS_V1, APPROVAL_OWNERS_MAX_V1, isApprovalOwnerTextV1, isApprovalSignalIdV1 } from '../src/index.js';

describe('approval owner choice', () => {
  it('accepts trimmed owner text of 1 to 120 code units', () => {
    expect(APPROVAL_OWNER_MAX_CHARACTERS_V1).toBe(120);
    expect(APPROVAL_OWNERS_MAX_V1).toBe(40);
    for (const owner of ['A', 'Rafael Moreno', 'Ana  María', 'x'.repeat(120), 'Zoë (design)', '山田 太郎']) expect(isApprovalOwnerTextV1(owner)).toBe(true);
  });
  it('refuses empty, padded, overlong, control and format text and non-strings', () => {
    for (const owner of ['', ' ', ' padded', 'padded ', 'x'.repeat(121), 'line\nbreak', 'tab\there', 'zero​width', 'bidi‮mark', 'nul\u0000', 42, null, undefined, ['A']]) {
      expect(isApprovalOwnerTextV1(owner)).toBe(false);
    }
  });
  it('accepts only record identifiers as signal ids', () => {
    for (const id of ['act-1', 'A', 'sig:1.2_3', 'a'.repeat(256)]) expect(isApprovalSignalIdV1(id)).toBe(true);
    for (const id of ['', '-act', 'act 1', 'act/1', 'a'.repeat(257), 7, null]) expect(isApprovalSignalIdV1(id)).toBe(false);
  });
});
