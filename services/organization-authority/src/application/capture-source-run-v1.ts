import {
  assertCaptureSourceConfigV1, assertCaptureTextV1, buildContextCaptureEnvelopeV2, canonicalSourceContentV1, captureSourceConfigSha256V1,
  captureSourcePullRequestV2, classifyCaptureV1, ownCaptureSourceBatchV2, resolveCaptureContainerV1, sourceItemIdV1,
  CAPTURE_DEFAULT_CLASSIFIER_V1,
  type AdapterOperationContext, type CaptureBindingsV1, type CaptureClassificationV1, type CaptureContainerScopeV1,
  type CaptureLocalClassifierV1, type CaptureProviderMapV2, type CaptureRevisionRefV1, type CaptureSnapshotSelectionV1,
  type CaptureSourceConfigV1, type ContextCaptureEnvelopeV2, type SourceAdapterIdentityV1,
} from '@echo-brain/organization-processing/core';
import { snapshotCaptureDataV1, type CaptureFoundationAuthorityV1 } from './capture-foundation-v1.js';
import { createCaptureSourceAuthorityV1, type CaptureSourceAuthorityCheckersV1 } from './capture-source-authority-v1.js';

type CaptureRetryRefV1 = CaptureRevisionRefV1 & { readonly reason: 'needs_review' };
/** Layer 1 custody, implemented by the SQLite capture foundation. */
export interface CaptureSourceStoreV2 {
  head(input: { readonly organization_id: string; readonly source_id: string }): ContextCaptureEnvelopeV2 | undefined;
  /** Retained capture records for one installed adapter. It never falls unless custody was rolled back. */
  captureCount(input: { readonly organization_id: string; readonly adapter_id: string; readonly instance_id: string }): number;
  admit(input: {
    readonly identity: SourceAdapterIdentityV1; readonly source: ContextCaptureEnvelopeV2;
    readonly classification: CaptureClassificationV1; readonly bindings?: CaptureBindingsV1;
  }): { readonly admission: 'skipped' } |
      { readonly admission: 'unresolved'; readonly cursor_may_advance: false; readonly retry: CaptureRetryRefV1 } |
      { readonly admission: 'admitted' | 'duplicate'; readonly selection: CaptureSnapshotSelectionV1 };
}
/**
 * Per-source bookmark. It is not atomic with custody: a crash after admission replays
 * the batch, and unchanged items return `duplicate`. `retained` is the adapter instance's
 * capture count when the bookmark advanced; custody with fewer records is behind it.
 */
export interface CaptureBookmarkV1 {
  readonly cursor: string;
  readonly retained: number;
  readonly adapter_id: string;
  readonly instance_id: string;
}
export interface CaptureCursorStoreV1 {
  read(source_id: string): CaptureBookmarkV1 | undefined;
  write(input: CaptureBookmarkV1 & { readonly source_id: string; readonly updated_at: string }): void;
  clear(source_id: string): void;
}
/** Counts only. No content leaves a run. */
export interface CaptureSourceRunResultV1 {
  readonly admitted: number;
  readonly duplicate: number;
  readonly skipped: number;
  /** Body-free retry reference for the first unresolved item. The bookmark did not advance. */
  readonly stopped_at?: CaptureRetryRefV1;
}
export interface CaptureSourceRunnerOptionsV1<TDeps> {
  /** Passed in by composition or tests. Storing and editing configuration is later work. */
  readonly configs: readonly CaptureSourceConfigV1[];
  readonly providers: CaptureProviderMapV2<TDeps>;
  readonly provider_deps: TDeps;
  readonly open_store: (input: { readonly containers: CaptureContainerScopeV1; readonly authority: CaptureFoundationAuthorityV1 }) => CaptureSourceStoreV2;
  readonly cursors: CaptureCursorStoreV1;
  readonly checkers?: CaptureSourceAuthorityCheckersV1;
  /** Local rule sets a configuration may name. Defaults to the retain-all rules. */
  readonly classifiers?: readonly CaptureLocalClassifierV1[];
  readonly limit?: number;
  readonly now?: () => string;
}
export interface CaptureSourceRunnerV1 {
  /**
   * One manual pull for one configured source. There is no timer; callers own scheduling.
   * Concurrent runs of a source are refused within this runner, not across processes.
   */
  runCaptureSourceOnce(source_id: string, context?: AdapterOperationContext): Promise<CaptureSourceRunResultV1>;
}
interface PreparedCaptureV1 {
  readonly source: ContextCaptureEnvelopeV2;
  readonly classification: CaptureClassificationV1;
  readonly bindings?: CaptureBindingsV1;
}

/**
 * Vendor-free capture: provider content in, Layer 1 custody out. Knowing which tool an
 * item came from is data (adapter ID, reference prefix, origin), never a branch here.
 */
export function createCaptureSourceRunnerV1<TDeps>(options: CaptureSourceRunnerOptionsV1<TDeps>): CaptureSourceRunnerV1 {
  const configs = new Map<string, CaptureSourceConfigV1>();
  const adapters = new Set<string>();
  for (const config of options.configs) {
    assertCaptureSourceConfigV1(config);
    // Two sources on one installed adapter would share item lineages and race each other.
    const adapter = canonicalSourceContentV1([config.adapter.adapter_id, config.adapter.instance_id]);
    if (configs.has(config.source_id) || adapters.has(adapter)) throw new Error('Capture source IDs and adapter instances must be unique');
    configs.set(config.source_id, snapshotCaptureDataV1(config));
    adapters.add(adapter);
  }
  const classifiers = [...(options.classifiers ?? [CAPTURE_DEFAULT_CLASSIFIER_V1])];
  const limit = captureSourcePullRequestV2({ limit: options.limit ?? 50 }).limit;
  const now = options.now ?? (() => new Date().toISOString());
  const { providers, provider_deps: deps, open_store: openStore, cursors, checkers } = options;
  const running = new Set<string>();

  async function run(sourceId: string, context: AdapterOperationContext | undefined): Promise<CaptureSourceRunResultV1> {
    // 1. Configuration, local rules and provider.
    const config = configs.get(sourceId);
    if (config === undefined) throw new Error('Capture source is not configured');
    const classifier = classifiers.find(entry => entry.id === config.classifier.id && entry.version === config.classifier.version);
    if (classifier === undefined) throw new Error('Capture source classifier is not available');
    const factory = Object.hasOwn(providers, config.adapter.adapter_id) ? providers[config.adapter.adapter_id] : undefined;
    if (factory === undefined) throw new Error('Capture source has no registered provider');
    const provider = factory(config, deps);
    const identity = canonicalSourceContentV1(config.adapter);
    const checkIdentity = (): void => {
      if (canonicalSourceContentV1(provider.source.identity) !== identity) throw new Error('Capture provider differs from its configured adapter');
    };
    checkIdentity();
    const store = openStore({ containers: config.containers, authority: createCaptureSourceAuthorityV1(config, checkers) });
    const custody = { organization_id: config.scope.organization_id, adapter_id: config.adapter.adapter_id, instance_id: config.adapter.instance_id };
    // 2. Bookmark, read grant, pull. A bookmark must prove itself against custody. If it came
    // from another adapter instance, or fewer captures are retained than when it advanced
    // (custody was rolled back or replaced behind it), forget it before pulling, so an
    // interrupted replay cannot revive it. Replay from the start only finds duplicates.
    const bookmark = cursors.read(sourceId);
    let cursor = bookmark?.cursor;
    if (bookmark !== undefined && (bookmark.adapter_id !== custody.adapter_id || bookmark.instance_id !== custody.instance_id ||
        store.captureCount(custody) < bookmark.retained)) {
      cursors.clear(sourceId);
      cursor = undefined;
    }
    const request = captureSourcePullRequestV2({ limit, ...(cursor === undefined ? {} : { cursor }) });
    await provider.require_read_current(context);
    context?.signal.throwIfAborted(); checkIdentity();
    const returned = await provider.source.pull(request, context);
    context?.signal.throwIfAborted(); checkIdentity();
    // 3. Own the returned bytes before the grant recheck can yield.
    const batch = ownCaptureSourceBatchV2(returned, request);
    await provider.require_read_current(context);
    context?.signal.throwIfAborted(); checkIdentity();

    // Synchronous from here: no other work in this process interleaves with admission.
    const producer = { id: config.classifier.id, version: config.classifier.version, config_sha256: captureSourceConfigSha256V1(config) };
    // 4a. Build and classify the whole batch before storing any of it. Items are unique
    // within a batch, so each predecessor is the retained head.
    const prepared: (PreparedCaptureV1 | undefined)[] = [];
    for (const item of batch.items) {
      const previous = store.head({ organization_id: config.scope.organization_id, source_id: sourceItemIdV1(config.adapter, item.external_id) });
      // A tombstone for an item never retained has nothing to record against.
      if (item.content.lifecycle === 'deleted' && previous === undefined) { prepared.push(undefined); continue; }
      const source = snapshotCaptureDataV1(buildContextCaptureEnvelopeV2({ identity: config.adapter, external_id: item.external_id,
        captured_at: item.captured_at, content: item.content, ...(previous === undefined ? {} : { previous }) }));
      const classification = classifyCaptureV1({ source, producer, rules: classifier.rules });
      if (classification.decision !== 'retain') {
        prepared.push({ source, classification });
        if (classification.decision === 'unresolved') break;
        continue;
      }
      const mapping = resolveCaptureContainerV1(config.containers, source);
      prepared.push({ source, classification, bindings: { scope: config.scope, project_id: mapping.project_id, container_ref: mapping.container_ref, people: [] } });
    }
    // 4b. Admit in order. 5. Stop at the first unresolved item without advancing the bookmark.
    let admitted = 0; let duplicate = 0; let skipped = 0;
    for (const entry of prepared) {
      if (entry === undefined) { skipped += 1; continue; }
      const result = store.admit({ identity: config.adapter, ...entry });
      if (result.admission === 'unresolved') return Object.freeze({ admitted, duplicate, skipped, stopped_at: snapshotCaptureDataV1(result.retry) });
      if (result.admission === 'skipped') skipped += 1;
      else if (result.admission === 'admitted') admitted += 1;
      else duplicate += 1;
    }
    // 6. The whole batch is admitted. An absent next cursor keeps the stored bookmark. The count
    // covers every capture retained so far, including any admitted by runs that never advanced it.
    if (batch.next_cursor !== undefined) {
      cursors.write({ source_id: sourceId, cursor: batch.next_cursor, retained: store.captureCount(custody),
        adapter_id: custody.adapter_id, instance_id: custody.instance_id, updated_at: now() });
    }
    return Object.freeze({ admitted, duplicate, skipped });
  }

  return Object.freeze({
    async runCaptureSourceOnce(source_id: string, context?: AdapterOperationContext): Promise<CaptureSourceRunResultV1> {
      context?.signal.throwIfAborted();
      assertCaptureTextV1(source_id, 'Capture source ID', 256);
      if (running.has(source_id)) throw new Error('Capture source already has a run in progress');
      running.add(source_id);
      try { return await run(source_id, context); } finally { running.delete(source_id); }
    },
  });
}
