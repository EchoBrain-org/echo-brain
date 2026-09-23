import type { PersonDocumentUploadMetadataV1, PersonDocumentReceiptV1, PersonDocumentMetadataV1, PersonDocumentTextV1, PersonDocumentSearchV1, PersonDocumentSearchResultV1, PersonDocumentExtractionStateV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';

export interface PersonDocumentOriginalV1 { readonly metadata: PersonDocumentMetadataV1; readonly bytes: Uint8Array }
export interface DocumentExtractionClaimV1 {
  readonly document_id: string; readonly lease_token: string; readonly bytes: Uint8Array;
  readonly filename: string; readonly source_sha256: string; readonly authorization_sha256: string;
}
export interface DocumentExtractionResultV1 {
  readonly status: Exclude<PersonDocumentExtractionStateV1, 'extracting'>;
  readonly sourceSha256: string; readonly extractorVersion: string;
  readonly chunks: readonly { readonly anchor_kind: 'page' | 'paragraph'; readonly anchor_start: number; readonly text: string }[];
  readonly message: string | null;
}
export type DocumentReadRequestV1 =
  | { readonly operation: 'status'; readonly request_id: string }
  | { readonly operation: 'metadata' | 'original'; readonly document_id: string; readonly project_id?: string | null }
  | { readonly operation: 'text'; readonly document_id: string; readonly cursor: string | null; readonly project_id?: string | null }
  | { readonly operation: 'search'; readonly request: PersonDocumentSearchV1 };
export type DocumentReadResultV1 = PersonDocumentMetadataV1 | PersonDocumentOriginalV1 | PersonDocumentTextV1 | PersonDocumentSearchResultV1;
export interface PersonDocumentRepositoryV1 {
  preflight(actor: PersonAccessAuthorization, metadata?: PersonDocumentUploadMetadataV1): void;
  upload(actor: PersonAccessAuthorization, metadata: PersonDocumentUploadMetadataV1, bytes: Uint8Array, reauthenticate: () => PersonAccessAuthorization): PersonDocumentReceiptV1;
  read(actor: PersonAccessAuthorization, request: DocumentReadRequestV1, reauthenticate: () => PersonAccessAuthorization): DocumentReadResultV1;
  claimExtraction(): DocumentExtractionClaimV1 | undefined;
  completeExtraction(claim: DocumentExtractionClaimV1, result: DocumentExtractionResultV1): boolean;
}
export interface PersonDocumentApplicationV1 {
  preflight(accessToken: string, metadata?: unknown): void;
  upload(accessToken: string, metadata: unknown, bytes: Uint8Array): PersonDocumentReceiptV1;
  status(accessToken: string, requestId: unknown): PersonDocumentMetadataV1;
  read(accessToken: string, documentId: unknown, scope?: { readonly project_id?: unknown }): PersonDocumentMetadataV1;
  original(accessToken: string, documentId: unknown, scope?: { readonly project_id?: unknown }): PersonDocumentOriginalV1;
  text(accessToken: string, documentId: unknown, page?: { readonly cursor?: unknown; readonly project_id?: unknown }): PersonDocumentTextV1;
  search(accessToken: string, request: unknown): PersonDocumentSearchResultV1;
}
