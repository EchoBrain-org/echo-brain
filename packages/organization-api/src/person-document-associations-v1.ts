import { validatePersonUpdateRequestId } from './person-updates.js';
import { validatePersonDocumentIdV1 } from './person-documents-v1.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';

export interface PersonDocumentAssociateV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-document-associate-v1';
  readonly request_id: string;
  readonly document_id: `doc_${string}`;
  readonly project_id: ProjectIdV1;
}
export interface PersonDocumentDissociateV1 extends Omit<PersonDocumentAssociateV1, 'kind'> {
  readonly kind: 'echo-person-document-dissociate-v1';
}
export interface PersonDocumentAssociationReceiptV1 extends Omit<PersonDocumentAssociateV1, 'kind'> {
  readonly kind: 'echo-person-document-association-receipt-v1';
  readonly operation: 'associate' | 'dissociate';
  readonly received_at: string;
  readonly state: 'applied';
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error('Document association shape is invalid');
  return value as Record<string, unknown>;
}
const requestKeys = ['schema_version', 'kind', 'request_id', 'document_id', 'project_id'];
function request(value: unknown, kind: PersonDocumentAssociateV1['kind'] | PersonDocumentDissociateV1['kind']): PersonDocumentAssociateV1 | PersonDocumentDissociateV1 {
  const input = object(value, requestKeys);
  if (input.schema_version !== 1 || input.kind !== kind) throw new Error('Document association kind is invalid');
  return { schema_version: 1, kind, request_id: validatePersonUpdateRequestId(input.request_id),
    document_id: validatePersonDocumentIdV1(input.document_id), project_id: validateProjectIdV1(input.project_id) };
}
export function validatePersonDocumentAssociateV1(value: unknown): PersonDocumentAssociateV1 {
  return request(value, 'echo-person-document-associate-v1') as PersonDocumentAssociateV1;
}
export function validatePersonDocumentDissociateV1(value: unknown): PersonDocumentDissociateV1 {
  return request(value, 'echo-person-document-dissociate-v1') as PersonDocumentDissociateV1;
}
export function validatePersonDocumentAssociationReceiptV1(value: unknown): PersonDocumentAssociationReceiptV1 {
  const input = object(value, [...requestKeys, 'operation', 'received_at', 'state']);
  if (input.schema_version !== 1 || input.kind !== 'echo-person-document-association-receipt-v1' ||
      !['associate', 'dissociate'].includes(input.operation as string) || input.state !== 'applied' ||
      typeof input.received_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.received_at) ||
      !Number.isFinite(Date.parse(input.received_at))) throw new Error('Document association receipt is invalid');
  return { schema_version: 1, kind: 'echo-person-document-association-receipt-v1',
    request_id: validatePersonUpdateRequestId(input.request_id), document_id: validatePersonDocumentIdV1(input.document_id),
    project_id: validateProjectIdV1(input.project_id), operation: input.operation as 'associate' | 'dissociate',
    received_at: input.received_at, state: 'applied' };
}
