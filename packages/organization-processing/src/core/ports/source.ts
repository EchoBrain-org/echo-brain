import type { Adapter, AdapterOperationContext } from "../contracts/adapter.js";
import type {
  SourceAdapterIdentityV1,
  SourceAdmissionScopeV1,
  SourceBatchV1,
  SourceEnvelopeV1,
  SourcePullRequestV1,
} from "../contracts/source.js";

export interface SourceAdapterV1<TContent = unknown> extends Adapter {
  readonly identity: SourceAdapterIdentityV1;
  pull(request: SourcePullRequestV1, context?: AdapterOperationContext): Promise<SourceBatchV1<TContent>>;
}

/**
 * Durable admission must atomically retain identity, immutable revision and
 * content. Same identity/revision+content is duplicate; changed bytes for the
 * same revision are an error. A duplicate does not imply processing finished.
 */
export interface SourceAdmissionStoreV1 {
  admitSourceRevision(
    input: { readonly scope: SourceAdmissionScopeV1; readonly source: SourceEnvelopeV1 },
    context?: AdapterOperationContext,
  ): Promise<"admitted" | "duplicate">;
}

export interface SourceAdmissionBindingV1<TContent = unknown> {
  readonly scope: SourceAdmissionScopeV1 | ((source: SourceEnvelopeV1<TContent>) => SourceAdmissionScopeV1);
  readonly store: SourceAdmissionStoreV1;
}
