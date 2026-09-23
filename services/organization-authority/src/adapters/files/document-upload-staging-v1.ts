import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_DOCUMENT_MAX_ORIGINAL_BYTES } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonDocumentUploadStagingV1 } from '../../application/ports/document-upload-staging-v1.js';

function invalid(): never { throw new AuthorityOperationError('invalid_request', 'request failed'); }

/** Stages one bounded stream in private storage, releasing no partial original. */
export function createPersonDocumentUploadStagingV1(
  options: { readonly temporaryDirectory?: string } = {},
): PersonDocumentUploadStagingV1 {
  return {
    async stage(stream, metadata) {
      if (!Number.isSafeInteger(metadata.content_length) || metadata.content_length < 1 ||
          metadata.content_length > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES || !/^sha256:[0-9a-f]{64}$/.test(metadata.sha256)) invalid();
      const directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'echo-document-transfer-'));
      const path = join(directory, 'original');
      try {
        const file = await open(path, 'wx', 0o600);
        let size = 0;
        const digest = createHash('sha256');
        try {
          for await (const bytes of stream) {
            if (!(bytes instanceof Uint8Array)) invalid();
            size += bytes.byteLength;
            if (size > metadata.content_length || size > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) invalid();
            digest.update(bytes);
            let offset = 0;
            while (offset < bytes.byteLength) {
              const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
              if (bytesWritten === 0) throw new Error('Document staging write failed');
              offset += bytesWritten;
            }
          }
        } finally { await file.close(); }
        if (size !== metadata.content_length || `sha256:${digest.digest('hex')}` !== metadata.sha256) invalid();
        return await readFile(path);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
