import type Database from 'better-sqlite3';
import { assertContextCaptureEnvelopeV1, canonicalSourceContentV1, type AdapterOperationContext, type SourceAdapterIdentityV1, type SourceAdmissionScopeV1, type SourceAdmissionStoreV1, type SourceEnvelopeV1 } from '@echo-brain/organization-processing/core';
import {
  requireCurrentContextIntakePolicyV1, selectContextIntakePolicyV1, snapshotContextCaptureAdmissionV1,
  type ContextIntakeAuthorityV1,
} from '../../../application/context-intake-v1.js';
import { SqliteSourceAdmissionStoreV1 } from './source-admission-v1.js';

/** Opt-in custody adapter with a mandatory transaction-time Authority retention fence. */
export class SqliteContextCaptureStoreV1 implements SourceAdmissionStoreV1 {
  private readonly identity: SourceAdapterIdentityV1;

  constructor(private readonly database: Database.Database, private readonly authority: ContextIntakeAuthorityV1, identity: SourceAdapterIdentityV1) {
    this.identity = Object.freeze({ ...identity });
  }

  async admitSourceRevision(input: { readonly scope: SourceAdmissionScopeV1; readonly source: SourceEnvelopeV1 }, context?: AdapterOperationContext): Promise<'admitted' | 'duplicate'> {
    context?.signal.throwIfAborted();
    const snapshot = snapshotContextCaptureAdmissionV1(input, this.identity);
    const store = new SqliteSourceAdmissionStoreV1(this.database, (source, scope) => {
      context?.signal.throwIfAborted();
      assertContextCaptureEnvelopeV1(source, this.identity);
      // Reselect rather than trust an earlier read grant or pre-queue policy snapshot.
      const current = selectContextIntakePolicyV1(source, this.authority);
      if (current.disposition !== 'retained' || canonicalSourceContentV1(current.scope) !== canonicalSourceContentV1(scope)) {
        throw new Error('Context retention or custody changed before admission');
      }
      requireCurrentContextIntakePolicyV1(source, current, this.authority);
      context?.signal.throwIfAborted();
      // Existing admission runs this callback inside the same transaction, even for duplicates.
    });
    return store.admitSourceRevision(snapshot, context);
  }
}
