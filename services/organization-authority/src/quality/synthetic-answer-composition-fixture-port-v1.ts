import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type {
  ReleasedRetrievalPort,
  ReleasedRetrievalAtom,
  ReleasedRetrievalBatch,
} from "../answer-composition/retrieval-grounded-answer-composition.js";
import type { SyntheticAnswerCompositionAtomV1 } from "./synthetic-meeting-fixture-v1.js";

const digest = (value: unknown): Sha256Digest => canonicalSha256(value);

function queryTerms(queries: readonly string[]): ReadonlySet<string> {
  return new Set(
    queries.flatMap((query) =>
      (query.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? []),
    ),
  );
}

export function syntheticFixtureAtomIdV1(atom: SyntheticAnswerCompositionAtomV1): Sha256Digest {
  return digest({ kind: "synthetic-layer4-atom-v1", id: atom.id });
}

/**
 * An explicit released-retrieval boundary for synthetic evaluation. The
 * evaluator hands composition only atoms released for the fixture principal.
 */
export class SyntheticFixtureReleasedRetrievalPortV1 implements ReleasedRetrievalPort {
  readonly queries: Array<readonly string[]> = [];
  readonly releases: ReleasedRetrievalBatch[] = [];

  constructor(
    private readonly options: {
      readonly principal_id: string;
      readonly atoms: readonly SyntheticAnswerCompositionAtomV1[];
    },
  ) {}

  async retrieve(input: {
    readonly queries: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<ReleasedRetrievalBatch> {
    input.signal?.throwIfAborted();
    this.queries.push([...input.queries]);
    const terms = queryTerms(input.queries);
    const released_atoms: readonly ReleasedRetrievalAtom[] = this.options.atoms
      .filter(
        (atom) =>
          atom.readable_by_principal_ids.includes(this.options.principal_id) &&
          atom.search_terms.some((term) => terms.has(term)),
      )
      .map((atom) => ({
        atom_id: syntheticFixtureAtomIdV1(atom),
        record_sha256: digest({ kind: "synthetic-layer4-record-v1", id: atom.id }),
        policy_id: atom.policy_id,
        text: atom.text,
      }));
    const release: ReleasedRetrievalBatch = {
      release_id: digest({ principal_id: this.options.principal_id, released_atoms }),
      authority_id: "synthetic-quality-authority",
      organization_id: "synthetic-quality-organization",
      state_lineage_id: "synthetic-quality-lineage",
      principal_id: this.options.principal_id,
      membership_id: `synthetic-quality-membership:${this.options.principal_id}`,
      session_family_id: `synthetic-quality-session:${this.options.principal_id}`,
      generation_id: digest({ principal_id: this.options.principal_id, released_atoms }),
      record_head: {
        position: released_atoms.length,
        record_sha256: released_atoms.at(-1)?.record_sha256 ?? null,
      },
      released_atoms,
      query_hit_counts: Object.freeze(input.queries.map(() => released_atoms.length)),
      checked_at: "2026-08-29T00:00:00.000Z",
    };
    this.releases.push(release);
    return release;
  }

  async revalidate(input: {
    readonly release: ReleasedRetrievalBatch;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly checked_at: string }> {
    input.signal?.throwIfAborted();
    if (input.release.principal_id !== this.options.principal_id) {
      throw new Error("fixture release principal does not match the read port");
    }
    return { checked_at: "2026-08-29T00:00:01.000Z" };
  }
}
