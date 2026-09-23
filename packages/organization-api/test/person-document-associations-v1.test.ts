import { describe, expect, it } from 'vitest';
import { validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1, validatePersonDocumentAssociationReceiptV1 } from '../src/person-document-associations-v1.js';

const request = { schema_version: 1, kind: 'echo-person-document-associate-v1', request_id: '11111111-1111-4111-8111-111111111111', document_id: `doc_${'a'.repeat(64)}`, project_id: 'prj_22222222-2222-4222-8222-222222222222' };
describe('document association contracts', () => {
  it('admits exact association, dissociation and minimal receipt envelopes', () => {
    expect(validatePersonDocumentAssociateV1(request)).toEqual(request);
    const remove = { ...request, kind: 'echo-person-document-dissociate-v1' };
    expect(validatePersonDocumentDissociateV1(remove)).toEqual(remove);
    const receipt = { ...request, kind: 'echo-person-document-association-receipt-v1', operation: 'associate', state: 'applied', received_at: '2026-09-23T00:00:00.000Z' };
    expect(validatePersonDocumentAssociationReceiptV1(receipt)).toEqual(receipt);
  });
  it('does not accept audience changes, mismatched commands or ambiguous identifiers', () => {
    for (const bad of [{ ...request, audience: { kind: 'team' } }, { ...request, document_id: '../document' }, { ...request, project_id: null }, { ...request, request_id: 'arbitrary' }, { ...request, schema_version: 2 }, { ...request, kind: 'echo-person-document-dissociate-v1' }]) {
      expect(() => validatePersonDocumentAssociateV1(bad)).toThrow();
    }
    const receipt = { ...request, kind: 'echo-person-document-association-receipt-v1', operation: 'associate', state: 'applied', received_at: '2026-09-23T00:00:00.000Z' };
    for (const bad of [{ ...receipt, title: 'private content' }, { ...receipt, state: 'pending' }, { ...receipt, operation: 'upload' }, { ...receipt, received_at: 'not a date' }]) expect(() => validatePersonDocumentAssociationReceiptV1(bad)).toThrow();
  });
});
