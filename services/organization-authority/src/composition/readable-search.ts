import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  OpaqueReadableSearchMachine,
  admitReadableSearchGenerationDirectory,
} from '@echo-brain/organization-retrieval/serve';
import type {
  OpenedReadableSearchGeneration,
  ReadableSearchHandleObserver,
} from '@echo-brain/organization-retrieval/serve';
import {
  organizationMemberSegmentIdentity,
  readableSearchSegmentManifestSha256,
  reviewerSegmentIdentity,
} from '@echo-brain/organization-retrieval';
import type {
  ReadableSearchAnalyzerDescriptor,
} from '@echo-brain/organization-retrieval';
import type { ReadableSearchScopeV1 } from '@echo-brain/organization-retrieval/serve';
import {
  OrganizationAuthorityApplication,
  type ReadableSearchRecordHeadVerifier,
} from '../application/organization-authority.js';
import {
  ReadableSearchAuthorizationFence,
} from '../application/readable-search-authorization-fence.js';
import {
  ReadableSearchError,
  ReadableSearchService,
  type ReadableSearchCandidate,
  type ReadableSearchContract,
  type ReadableSearchFetchedItem,
  type ReadableSearchGenerationBinding,
  type ReadableSearchRetrievalPort,
  type ReadableSearchScope,
} from '../application/readable-search.js';
import type { OrganizationRecordRuntime } from './organization-record.js';
import type { StoredReadableSearchActiveGeneration } from '../application/ports/authority-repository.js';

export interface ReadableSearchGenerationDirectoryResolver {
  directoryFor(generationId: Sha256Digest): string;
}

export interface CreateReadableSearchRuntimeAdapterOptions {
  readonly authority: OrganizationAuthorityApplication;
  readonly records: Pick<
    OrganizationRecordRuntime,
    'verifyChain' | 'readableSearchLayer1Admission'
  >;
  readonly generation_directories: ReadableSearchGenerationDirectoryResolver;
  /** The private Layer 2 state root, passed directly to serving admission. */
  readonly retrieval_state_directory: string;
  readonly analyzer: ReadableSearchAnalyzerDescriptor;
  readonly contract: ReadableSearchContract;
  /** The singleton shared with every eventual Authority/record writer. */
  readonly fence: ReadableSearchAuthorizationFence;
  /** Required at the production composition boundary so queued reads are bounded. */
  readonly fence_timeout_ms: number;
  /** Test-only observation of request-local plane opens. */
  readonly handle_observer?: ReadableSearchHandleObserver;
  /** Test seam; production uses the closed serving admission function. */
  readonly admit_generation?: (input: {
    readonly generation_directory: string;
    readonly admission: {
      readonly state_directory: string;
      readonly organization_id: string;
      readonly record_head: { readonly position: number; readonly record_hash: Sha256Digest | null };
      readonly retrieval_contract_sha256: Sha256Digest;
      readonly analyzer: ReadableSearchAnalyzerDescriptor;
    };
  }) => OpenedReadableSearchGeneration;
}

interface OpaqueScopeState {
  readonly opaque: ReadableSearchScopeV1;
  readonly machine: OpaqueReadableSearchMachine;
  readonly candidates: readonly ReadableSearchCandidate[] | null;
}

interface CapturedGeneration {
  readonly active: StoredReadableSearchActiveGeneration;
  readonly generation: OpenedReadableSearchGeneration;
  readonly member_policy_contract_sha256: Sha256Digest;
  readonly reviewer_policy_contract_sha256: Sha256Digest;
}

type CapturedGenerationState =
  | { readonly kind: 'ready'; readonly value: CapturedGeneration }
  | { readonly kind: 'unavailable'; readonly cause: unknown };

function recordHead(
  records: Pick<OrganizationRecordRuntime, 'verifyChain'>,
): { readonly position: number; readonly record_hash: Sha256Digest | null } {
  const verification = records.verifyChain();
  if (verification.failures.length !== 0) {
    throw new ReadableSearchError(
      'unavailable',
      'readable-search record chain verification failed',
    );
  }
  return Object.freeze({
    position: verification.head_position ?? 0,
    record_hash: verification.head_record_hash,
  });
}

function sameHead(
  left: { readonly position: number; readonly record_hash: Sha256Digest | null },
  right: { readonly position: number; readonly record_hash: Sha256Digest | null },
): boolean {
  return left.position === right.position && left.record_hash === right.record_hash;
}

function matchingRecordHeadVerifier(
  records: Pick<OrganizationRecordRuntime, 'verifyChain'>,
): ReadableSearchRecordHeadVerifier {
  return Object.freeze({
    stillMatches(binding: ReadableSearchGenerationBinding) {
      try {
        return sameHead(recordHead(records), {
          position: binding.record_head_position,
          record_hash: binding.record_head_hash,
        });
      } catch {
        return false;
      }
    },
  });
}

function sameActiveGeneration(
  left: StoredReadableSearchActiveGeneration,
  right: StoredReadableSearchActiveGeneration,
): boolean {
  return (
    left.organization_id === right.organization_id &&
    left.generation_id === right.generation_id &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.retrieval_contract_sha256 === right.retrieval_contract_sha256 &&
    left.record_head_position === right.record_head_position &&
    left.record_head_hash === right.record_head_hash
  );
}

/**
 * Startup performs the complete immutable-generation admission once. Its
 * broad integrity reads are never on a requester path; serving receives only
 * this pinned result and opens plane handles through request-local scopes.
 */
function captureGeneration(
  options: CreateReadableSearchRuntimeAdapterOptions,
): CapturedGenerationState {
  try {
    const layer1 = options.records.readableSearchLayer1Admission;
    if (layer1 === null) {
      throw new Error('readable-search Layer 1 admission is unavailable');
    }
    const active = options.authority.readableSearchActiveGeneration();
    if (active === null) throw new Error('no active readable-search generation');
    const head = recordHead(options.records);
    if (!sameHead(head, layer1.record_head)) {
      throw new Error('readable-search Layer 1 admission is not at the current record head');
    }
    if (
      !sameHead(head, {
        position: active.record_head_position,
        record_hash: active.record_head_hash,
      })
    ) {
      throw new Error('active readable-search generation is not at the current record head');
    }
    const admit = options.admit_generation ?? admitReadableSearchGenerationDirectory;
    const generation = admit({
      generation_directory: options.generation_directories.directoryFor(
        active.generation_id,
      ),
      admission: {
        state_directory: options.retrieval_state_directory,
        organization_id: active.organization_id,
        record_head: head,
        retrieval_contract_sha256: active.retrieval_contract_sha256,
        analyzer: options.analyzer,
      },
    });
    const member = generation.manifest.policies.find(
      (value) => value.policy_id === 'organization-member-readable-v1',
    );
    const reviewer = generation.manifest.policies.find(
      (value) => value.policy_id === 'restricted-reviewer-v1',
    );
    if (
      generation.manifest.generation_id !== active.generation_id ||
      generation.manifest_sha256 !== active.manifest_sha256 ||
      generation.manifest.upstream_input_root !== layer1.upstream_input_root ||
      generation.manifest.retrieval_contract_sha256 !==
        options.contract.retrieval_contract_sha256 ||
      member === undefined ||
      reviewer === undefined ||
      member.policy_contract_sha256 !==
        options.contract.policy_contracts[0].policy_contract_sha256 ||
      reviewer.policy_contract_sha256 !==
        options.contract.policy_contracts[1].policy_contract_sha256
    ) {
      throw new Error('active readable-search generation does not match its pinned contracts');
    }
    return Object.freeze({
      kind: 'ready',
      value: Object.freeze({
        active,
        generation,
        member_policy_contract_sha256: member.policy_contract_sha256,
        reviewer_policy_contract_sha256: reviewer.policy_contract_sha256,
      }),
    });
  } catch (cause) {
    return Object.freeze({ kind: 'unavailable', cause });
  }
}

/**
 * Wires the Authority-owned current-Person/final-audit port to the retrieval
 * serving subpath.  It does not construct an HTTP listener or expose a
 * generic record/SQLite reader.
 */
export function createReadableSearchRuntimeAdapter(
  options: CreateReadableSearchRuntimeAdapterOptions,
): ReadableSearchService {
  const statePort = options.authority.createBoundReadableSearchAuthorityStatePort(
    matchingRecordHeadVerifier(options.records),
  );
  const captured = captureGeneration(options);
  const scopes = new WeakMap<object, OpaqueScopeState>();

  const retrieval: ReadableSearchRetrievalPort = {
    openScope: ({ authenticated, person }) => {
      if (captured.kind !== 'ready') {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search generation was unavailable at runtime admission',
          { cause: captured.cause },
        );
      }
      const { active, generation } = captured.value;
      const currentActive = options.authority.readableSearchActiveGeneration();
      const currentHead = recordHead(options.records);
      if (
        currentActive === null ||
        !sameActiveGeneration(currentActive, active) ||
        !sameHead(currentHead, {
          position: active.record_head_position,
          record_hash: active.record_head_hash,
        })
      ) {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search active generation is not at the current record head',
        );
      }
      const memberSegment = organizationMemberSegmentIdentity({
        organization_id: active.organization_id,
        policy_contract_sha256: captured.value.member_policy_contract_sha256,
      });
      const admitted = [memberSegment];
      const reviewerSegment = reviewerSegmentIdentity({
        organization_id: active.organization_id,
        policy_contract_sha256: captured.value.reviewer_policy_contract_sha256,
        reviewer_principal_id: person.principal_id,
        reviewer_membership_id: person.membership_id,
      });
      if (generation.segments.has(reviewerSegment.segment_id)) {
        admitted.push(reviewerSegment);
      }
      const admittedSegments = admitted.map((identity) => {
        const segment = generation.segments.get(identity.segment_id);
        if (segment === undefined) {
          throw new ReadableSearchError(
            'unavailable',
            'readable-search required segment is unavailable',
          );
        }
        return {
          policy_id: identity.policy_id,
          segment_manifest_sha256: readableSearchSegmentManifestSha256(
            segment.manifest,
          ),
          segment_id: identity.segment_id,
        };
      });
      const binding = Object.freeze({
        generation_id: active.generation_id,
        manifest_sha256: active.manifest_sha256,
        record_head_position: active.record_head_position,
        record_head_hash: active.record_head_hash,
        retrieval_contract_sha256: active.retrieval_contract_sha256,
        policy_contracts: options.contract.policy_contracts,
      });
      const scopeBindingSha256 = canonicalSha256({
        schema_version: 1,
        kind: 'readable-search-scope-binding-v1',
        request_sha256: authenticated.request_sha256,
        requester: {
          principal_id: person.principal_id,
          membership_id: person.membership_id,
          membership_type: person.membership_type,
          enrollment_id: person.enrollment_id,
          installation_id: person.installation_id,
        },
        person_state_sha256: person.person_state_sha256,
        operation: 'search-readable',
        retrieval_contract_sha256: binding.retrieval_contract_sha256,
        policy_contracts: binding.policy_contracts,
        generation: {
          generation_id: binding.generation_id,
          manifest_sha256: binding.manifest_sha256,
        },
        record_head: {
          position: binding.record_head_position,
          record_hash: binding.record_head_hash,
        },
        admitted_segments: admittedSegments.map((segment) => ({
          policy_id: segment.policy_id,
          segment_manifest_sha256: segment.segment_manifest_sha256,
        })),
      });
      const machine = new OpaqueReadableSearchMachine(
        generation,
        options.handle_observer,
      );
      const opaque = machine.bind({
        request_sha256: authenticated.request_sha256,
        caller_binding_sha256: scopeBindingSha256,
        admitted_segment_ids: admittedSegments.map((segment) => segment.segment_id),
      });
      let scope: ReadableSearchScope;
      scope = Object.freeze({
        binding,
        scope_binding_sha256: scopeBindingSha256,
        reviewer_tuple: generation.segments.has(reviewerSegment.segment_id)
          ? Object.freeze({
              principal_id: person.principal_id,
              membership_id: person.membership_id,
            })
          : null,
        selected_policy_paths_still_match: (
          candidates: readonly ReadableSearchCandidate[],
        ) => {
          const state = scopes.get(scope);
          if (state === undefined || state.candidates === null) return false;
          const selected = state.candidates;
          return (
            selected.length === candidates.length &&
            selected.every(
            (candidate, index) =>
              candidate.atom_id === candidates[index]?.atom_id &&
              candidate.record_hash === candidates[index]?.record_hash &&
              candidate.policy_id === candidates[index]?.policy_id,
            ) &&
            state.machine.selectedAuditBindingsStillValid(
              state.opaque,
              selected,
            )
          );
        },
      });
      scopes.set(scope, { opaque, machine, candidates: null });
      return scope;
    },
    search: (scope, query) => {
      const state = scopes.get(scope);
      if (state === undefined || state.candidates !== null) {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search scope is invalid or reused',
        );
      }
      state.machine.search(state.opaque, query);
      const candidates = state.machine.selectedAuditCandidates(state.opaque).map(
        (candidate) =>
          Object.freeze({
            atom_id: candidate.atom_id as Sha256Digest,
            record_hash: candidate.record_hash as Sha256Digest,
            policy_id: candidate.policy_id,
          }),
      );
      // The opaque scope is request-local. Mutating its private weak-map body
      // is impossible, so retain selection separately for fetch equivalence.
      const selected = Object.freeze(candidates);
      scopes.set(scope, { ...state, candidates: selected });
      return selected;
    },
    fetch: (scope, candidates) => {
      const state = scopes.get(scope);
      if (
        state === undefined ||
        state.candidates === null ||
        state.candidates.length !== candidates.length ||
        state.candidates.some(
          (candidate, index) =>
            candidate.atom_id !== candidates[index]?.atom_id ||
            candidate.record_hash !== candidates[index]?.record_hash ||
            candidate.policy_id !== candidates[index]?.policy_id,
        )
      ) {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search content fetch has different candidate bindings',
        );
      }
      const fetched = state.machine.fetchWithAudit(state.opaque);
      if (fetched.items.length !== fetched.audit_items.length) {
        throw new ReadableSearchError(
          'unavailable',
          'readable-search fetched result bindings are incomplete',
        );
      }
      return Object.freeze(
        fetched.items.map((item, index) => {
          const audit = fetched.audit_items[index];
          if (audit === undefined) {
            throw new ReadableSearchError(
              'unavailable',
              'readable-search fetched result audit binding is missing',
            );
          }
          return Object.freeze({
            atom_id: audit.atom_id as Sha256Digest,
            record_hash: audit.record_hash as Sha256Digest,
            policy_id: audit.policy_id,
            kind: item.kind,
            text: item.text,
          } satisfies ReadableSearchFetchedItem);
        }),
      );
    },
    close: (scope) => {
      const state = scopes.get(scope);
      if (state !== undefined) state.machine.close(state.opaque);
    },
  };

  return new ReadableSearchService({
    authority: statePort,
    retrieval,
    fence: options.fence,
    contract: options.contract,
    fence_timeout_ms: options.fence_timeout_ms,
  });
}
