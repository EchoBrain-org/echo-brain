/** Private transient bytes only; successful staging does not admit an original. */
export interface PersonDocumentUploadStagingV1 {
  stage(
    stream: AsyncIterable<Uint8Array>,
    metadata: { readonly content_length: number; readonly sha256: string },
  ): Promise<Uint8Array>;
}
