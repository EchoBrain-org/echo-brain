import { validateProjectIdV1, validatePersonDocumentIdV1, validatePersonDocumentSearchV1, validatePersonDocumentUploadMetadataV1, validatePersonUpdateRequestId, type PersonDocumentUploadResultV1, type PersonDocumentStatusV1, type PersonDocumentMetadataV1, type PersonDocumentTextV1, type PersonDocumentSearchResultV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonDocumentApplicationV1, PersonDocumentRepositoryV1, DocumentReadRequestV1, DocumentReadResultV1, PersonDocumentOriginalV1 } from './ports/document-v1.js';
import { createPersonDocumentAssociationApplicationV1 } from './document-associations-v1.js';
export interface PersonDocumentApplicationDependenciesV1 { readonly authenticate: (accessToken: string) => PersonAccessAuthorization; readonly repository: PersonDocumentRepositoryV1; readonly on_original_saved?: () => void }
function valid<T>(fn: () => T): T { try { return fn(); } catch { throw new AuthorityOperationError('invalid_request', 'Document request is invalid'); } }
function projectScope(value: unknown): string | null { return value == null ? null : valid(() => validateProjectIdV1(value, 'project_id')); }
export function createPersonDocumentApplicationV1(dependencies: PersonDocumentApplicationDependenciesV1): PersonDocumentApplicationV1 {
  const read = (token: string, request: DocumentReadRequestV1): DocumentReadResultV1 => dependencies.repository.read(dependencies.authenticate(token), request, () => dependencies.authenticate(token));
  return {
    ...createPersonDocumentAssociationApplicationV1(dependencies),
    preflight(token, input) { const actor = dependencies.authenticate(token); dependencies.repository.preflight(actor, input === undefined ? undefined : valid(() => validatePersonDocumentUploadMetadataV1(input))); },
    upload(token, input, bytes): PersonDocumentUploadResultV1 { const actor = dependencies.authenticate(token); const metadata = valid(() => validatePersonDocumentUploadMetadataV1(input)); const saved=dependencies.repository.upload(actor, metadata, bytes, () => dependencies.authenticate(token)); try { dependencies.on_original_saved?.(); } catch {} return saved; },
    status(token, input) { const request_id = valid(() => validatePersonUpdateRequestId(input)); return read(token, { operation: 'status', request_id }) as PersonDocumentStatusV1; },
    read(token, input, scope = {}) { return read(token, { operation: 'metadata', document_id: valid(() => validatePersonDocumentIdV1(input)), project_id: projectScope(scope.project_id) }) as PersonDocumentMetadataV1; },
    original(token, input, scope = {}) { return read(token, { operation: 'original', document_id: valid(() => validatePersonDocumentIdV1(input)), project_id: projectScope(scope.project_id) }) as PersonDocumentOriginalV1; },
    text(token, input, page = {}) { const document_id = valid(() => validatePersonDocumentIdV1(input)); const cursor = page.cursor ?? null; if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new AuthorityOperationError('invalid_request', 'Document cursor is invalid'); return read(token, { operation: 'text', document_id, cursor, project_id: projectScope(page.project_id) }) as PersonDocumentTextV1; },
    search(token, input) { return read(token, { operation: 'search', request: valid(() => validatePersonDocumentSearchV1(input)) }) as PersonDocumentSearchResultV1; },
  };
}
