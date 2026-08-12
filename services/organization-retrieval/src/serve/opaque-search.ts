import {
  analyzeReadableSearchQuery,
  compareReadableSearchCandidates,
} from '../application/analyzer.js';
import { sha256Digest } from '@echo-brain/federation-protocol';
import type {
  ReadableSearchResultItem,
  ReadableSearchScopeInput,
  RetrievalContentAtom,
  RetrievalLexicalDocument,
  RetrievalPermissionFact,
  RetrievalTermPosting,
} from '../application/contracts.js';
import { ReadableSearchValidationError } from '../application/contracts.js';
import {
  readableSearchContentRoot,
  readableSearchFactsRoot,
  readableSearchLexicalRoot,
} from '../application/roots.js';
import {
  openAdmittedReadableSearchPlane,
  readFactsForAdmission,
  type AdmittedReadableSearchSegment,
  type OpenedReadableSearchGeneration,
} from './generation-admission.js';
import {
  READABLE_SEARCH_CONTENT_DATABASE,
  READABLE_SEARCH_LEXICAL_DATABASE,
} from '../persistence/database-definition.js';

const SCOPE_BRAND: unique symbol = Symbol('echo-readable-search-scope-v1');

export interface ReadableSearchScopeV1 {
  readonly [SCOPE_BRAND]: true;
}

interface Candidate {
  readonly segment: AdmittedReadableSearchSegment;
  readonly atom_id: string;
  readonly log_position: number;
  readonly atom_order: number;
  readonly score: number;
}

type ScopeState = 'bound' | 'lexical-searched' | 'empty' | 'content-fetched' | 'closed';

interface ScopeBody {
  readonly generation: OpenedReadableSearchGeneration;
  readonly request_sha256: string;
  readonly caller_binding_sha256: string;
  readonly segments: readonly AdmittedReadableSearchSegment[];
  readonly facts_by_segment: ReadonlyMap<string, readonly RetrievalPermissionFact[]>;
  state: ScopeState;
  candidates: readonly Candidate[] | null;
}

const scopes = new WeakMap<object, ScopeBody>();

function body(scope: ReadableSearchScopeV1, expected: ScopeState): ScopeBody {
  const value = scopes.get(scope as object);
  if (value === undefined || value.state !== expected) {
    throw new ReadableSearchValidationError('readable-search scope is invalid or out of order');
  }
  return value;
}

function lexicalCandidates(
  segment: AdmittedReadableSearchSegment,
  facts: readonly RetrievalPermissionFact[],
  terms: readonly string[],
): readonly Candidate[] {
  if (terms.length === 0) return [];
  const database = openAdmittedReadableSearchPlane(
    segment.lexical_path,
    READABLE_SEARCH_LEXICAL_DATABASE,
    segment.lexical_identity,
    {
      validate_opened: (opened) => {
        const documents = opened.prepare(
          'SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id',
        ).all() as RetrievalLexicalDocument[];
        const postings = opened.prepare(
          'SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id',
        ).all() as RetrievalTermPosting[];
        if (
          readableSearchLexicalRoot({
            segment_id: segment.manifest.segment_id,
            documents,
            postings,
          }) !== segment.manifest.lexical_root
        ) {
          throw new ReadableSearchValidationError(
            'readable-search opened lexical plane root differs from admission',
          );
        }
      },
    },
  );
  try {
    database.pragma('trusted_schema = OFF');
    const placeholders = terms.map(() => '?').join(',');
    const rows = database.prepare(
      `SELECT document.atom_id, document.log_position, document.atom_order,
              SUM(posting.term_frequency) AS score
       FROM retrieval_term_posting AS posting
       JOIN retrieval_lexical_document AS document ON document.atom_id = posting.atom_id
       WHERE posting.term IN (${placeholders})
       GROUP BY document.atom_id, document.log_position, document.atom_order`,
    ).all(...terms) as { atom_id: RetrievalPermissionFact['atom_id']; log_position: number; atom_order: number; score: number }[];
    const factsByAtom = new Map(facts.map((fact) => [fact.atom_id, fact]));
    return Object.freeze(
      rows.map((row) => {
        const fact = factsByAtom.get(row.atom_id);
        if (
          fact === undefined ||
          row.log_position !== fact.log_position ||
          row.atom_order !== fact.atom_order
        ) {
          throw new ReadableSearchValidationError(
            'readable-search lexical candidate differs from its admitted fact',
          );
        }
        return Object.freeze({ ...row, segment });
      }),
    );
  } finally {
    database.close();
  }
}

export interface ReadableSearchHandleObserver {
  opened(plane: 'facts' | 'lexical' | 'content', segment_id: string): void;
}

/**
 * The Authority needs these bindings only to commit its isolated decision
 * audit.  They are never part of the readable-search response wire.
 */
export interface ReadableSearchAuditResultItem {
  readonly atom_id: string;
  readonly record_hash: string;
  readonly policy_id: ReadableSearchResultItem['policy_id'];
}

export interface ReadableSearchAuditCandidate {
  readonly atom_id: string;
  readonly record_hash: string;
  readonly policy_id: ReadableSearchResultItem['policy_id'];
}

export interface ReadableSearchFetchedResultsV1 {
  readonly items: readonly ReadableSearchResultItem[];
  readonly audit_items: readonly ReadableSearchAuditResultItem[];
}

export class OpaqueReadableSearchMachine {
  constructor(
    private readonly generation: OpenedReadableSearchGeneration,
    private readonly observer?: ReadableSearchHandleObserver,
  ) {}

  bind(input: ReadableSearchScopeInput): ReadableSearchScopeV1 {
    if (input.admitted_segment_ids.length > 2) {
      throw new ReadableSearchValidationError('readable-search scope names too many segments');
    }
    const ids = new Set(input.admitted_segment_ids);
    if (ids.size !== input.admitted_segment_ids.length) {
      throw new ReadableSearchValidationError('readable-search scope repeats a segment');
    }
    const segments = input.admitted_segment_ids.map((segmentId) => {
      const segment = this.generation.segments.get(segmentId);
      if (segment === undefined) throw new ReadableSearchValidationError('readable-search scope names an undeclared segment');
      return segment;
    });
    const factsBySegment = new Map<string, readonly RetrievalPermissionFact[]>();
    for (const segment of segments) {
      this.observer?.opened('facts', segment.manifest.segment_id);
      factsBySegment.set(
        segment.manifest.segment_id,
        readFactsForAdmission(segment.facts_path, segment.facts_identity),
      );
    }
    for (const segment of segments) {
      const facts = factsBySegment.get(segment.manifest.segment_id);
      if (
        facts === undefined ||
        readableSearchFactsRoot(segment.manifest.segment_id, facts) !==
          segment.manifest.facts_root
      ) {
        throw new ReadableSearchValidationError(
          'readable-search opened facts plane root differs from admission',
        );
      }
    }
    const scope = Object.freeze({ [SCOPE_BRAND]: true }) as ReadableSearchScopeV1;
    scopes.set(scope as object, {
      generation: this.generation,
      request_sha256: input.request_sha256,
      caller_binding_sha256: input.caller_binding_sha256,
      segments: Object.freeze(segments),
      facts_by_segment: factsBySegment,
      state: 'bound',
      candidates: null,
    });
    return scope;
  }

  search(scope: ReadableSearchScopeV1, query: string): void {
    const current = body(scope, 'bound');
    const terms = analyzeReadableSearchQuery(query);
    const candidates = current.segments.flatMap((segment) => {
      const facts = current.facts_by_segment.get(segment.manifest.segment_id);
      if (facts === undefined) throw new ReadableSearchValidationError('readable-search scope lost its facts binding');
      this.observer?.opened('lexical', segment.manifest.segment_id);
      return lexicalCandidates(segment, facts, terms);
    });
    candidates.sort(compareReadableSearchCandidates);
    current.candidates = Object.freeze(candidates.slice(0, 10));
    current.state = current.candidates.length === 0 ? 'empty' : 'lexical-searched';
  }

  selectedAuditCandidates(
    scope: ReadableSearchScopeV1,
  ): readonly ReadableSearchAuditCandidate[] {
    const current = scopes.get(scope as object);
    if (
      current === undefined ||
      (current.state !== 'lexical-searched' && current.state !== 'empty')
    ) {
      throw new ReadableSearchValidationError(
        'readable-search candidate audit is invalid or out of order',
      );
    }
    const candidates = current.candidates;
    if (candidates === null) {
      throw new ReadableSearchValidationError(
        'readable-search audit candidates are missing',
      );
    }
    return Object.freeze(
      candidates.map((candidate) => {
        const facts = current.facts_by_segment.get(
          candidate.segment.manifest.segment_id,
        );
        const fact = facts?.find((value) => value.atom_id === candidate.atom_id);
        if (fact === undefined) {
          throw new ReadableSearchValidationError(
            'readable-search audit candidate lost its fact binding',
          );
        }
        return Object.freeze({
          atom_id: candidate.atom_id,
          record_hash: fact.record_hash,
          policy_id: fact.policy_id,
        });
      }),
    );
  }

  /**
   * Final Authority-side admission proof for the exact frozen candidate set.
   * It reads only the request-local facts snapshots, never an unscoped plane.
   */
  selectedAuditBindingsStillValid(
    scope: ReadableSearchScopeV1,
    selected: readonly ReadableSearchAuditCandidate[],
  ): boolean {
    const current = scopes.get(scope as object);
    if (current === undefined || current.state !== 'content-fetched') {
      return false;
    }
    const candidates = current.candidates;
    if (candidates === null || candidates.length !== selected.length) {
      return false;
    }
    return candidates.every((candidate, index) => {
      const expected = selected[index];
      const fact = current.facts_by_segment
        .get(candidate.segment.manifest.segment_id)
        ?.find((value) => value.atom_id === candidate.atom_id);
      return (
        expected !== undefined &&
        fact !== undefined &&
        expected.atom_id === candidate.atom_id &&
        expected.record_hash === fact.record_hash &&
        expected.policy_id === fact.policy_id
      );
    });
  }

  fetch(scope: ReadableSearchScopeV1): readonly ReadableSearchResultItem[] {
    return this.fetchWithAudit(scope).items;
  }

  fetchWithAudit(scope: ReadableSearchScopeV1): ReadableSearchFetchedResultsV1 {
    const current = scopes.get(scope as object);
    if (current === undefined || (current.state !== 'lexical-searched' && current.state !== 'empty')) {
      throw new ReadableSearchValidationError('readable-search content fetch is invalid or out of order');
    }
    if (current.state === 'empty') {
      current.state = 'content-fetched';
      return Object.freeze({
        items: Object.freeze([]),
        audit_items: Object.freeze([]),
      });
    }
    const candidates = current.candidates;
    if (candidates === null) throw new ReadableSearchValidationError('readable-search candidates are missing');
    const results: ReadableSearchResultItem[] = [];
    const auditItems: ReadableSearchAuditResultItem[] = [];
    for (const candidate of candidates) {
      const facts = current.facts_by_segment.get(candidate.segment.manifest.segment_id);
      const fact = facts?.find((value) => value.atom_id === candidate.atom_id);
      if (fact === undefined) throw new ReadableSearchValidationError('readable-search candidate lost its fact binding');
      this.observer?.opened('content', candidate.segment.manifest.segment_id);
      const database = openAdmittedReadableSearchPlane(
        candidate.segment.content_path,
        READABLE_SEARCH_CONTENT_DATABASE,
        candidate.segment.content_identity,
        {
          validate_opened: (opened) => {
            const content = opened.prepare(
              'SELECT * FROM retrieval_content_atom ORDER BY log_position, atom_order, atom_id',
            ).all() as RetrievalContentAtom[];
            if (
              readableSearchContentRoot(
                candidate.segment.manifest.segment_id,
                content,
              ) !== candidate.segment.manifest.content_root
            ) {
              throw new ReadableSearchValidationError(
                'readable-search opened content plane root differs from admission',
              );
            }
          },
        },
      );
      try {
        database.pragma('trusted_schema = OFF');
        const row = database.prepare(
          `SELECT atom_id, log_position, record_hash, atom_order, item_kind, text,
                  text_sha256, content_binding_sha256, provenance_binding_sha256
           FROM retrieval_content_atom WHERE atom_id = ?`,
        ).get(candidate.atom_id) as {
          atom_id: string;
          log_position: number;
          record_hash: string;
          atom_order: number;
          item_kind: ReadableSearchResultItem['kind'];
          text: string;
          text_sha256: string;
          content_binding_sha256: string;
          provenance_binding_sha256: string;
        } | undefined;
        if (
          row === undefined ||
          row.log_position !== fact.log_position ||
          row.record_hash !== fact.record_hash ||
          row.atom_order !== fact.atom_order ||
          row.item_kind !== fact.item_kind ||
          row.text_sha256 !== sha256Digest(row.text) ||
          row.content_binding_sha256 !== fact.content_binding_sha256 ||
          row.provenance_binding_sha256 !== fact.provenance_binding_sha256
        ) {
          throw new ReadableSearchValidationError('readable-search content binding is invalid');
        }
        results.push(Object.freeze({ kind: row.item_kind, text: row.text, policy_id: fact.policy_id }));
        auditItems.push(
          Object.freeze({
            atom_id: candidate.atom_id,
            record_hash: row.record_hash,
            policy_id: fact.policy_id,
          }),
        );
      } finally {
        database.close();
      }
    }
    current.state = 'content-fetched';
    return Object.freeze({
      items: Object.freeze(results),
      audit_items: Object.freeze(auditItems),
    });
  }

  close(scope: ReadableSearchScopeV1): void {
    const current = scopes.get(scope as object);
    if (current !== undefined) current.state = 'closed';
  }
}
