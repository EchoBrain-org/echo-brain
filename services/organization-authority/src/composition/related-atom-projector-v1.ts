import type { StructuredGenerationTransportV1 } from "../answer-composition/retrieval-grounded-answer-composition.js";

/**
 * Disposable Layer 2 projection core for material cross-record relationships.
 * It receives only approved retrieval-atom summaries from one exact visibility
 * segment. Raw meeting transcripts are intentionally outside this contract.
 */
export const MAX_RELATED_ATOM_SOURCE_ATOMS_V1 = 200;
export const MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1 = 196_608;
export const MAX_RELATED_ATOM_CANDIDATES_V1 = 6;
export const MAX_RELATED_ATOM_LINKS_PER_ATOM_V1 = 3;
export const MAX_RELATED_ATOM_LINKS_TOTAL_V1 = 6;
export const MIN_RELATED_ATOM_SUPPORTING_EXCERPT_LENGTH_V1 = 8;
export const RELATED_ATOM_PROJECTOR_MAX_OUTPUT_TOKENS_V1 = 2_000;
export const RELATED_ATOM_PROJECTOR_DEFAULT_TIMEOUT_MS_V1 = 30_000;
export const RELATED_ATOM_PROJECTOR_MAX_TIMEOUT_MS_V1 = 120_000;

export class RelatedAtomProjectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelatedAtomProjectorError";
  }
}

/** A summary already admitted to one exact visibility segment. */
export interface ApprovedRetrievalAtomSummaryV1 {
  readonly atom_id: string;
  /** Stable source-record identity used only to require cross-record pairs. */
  readonly record_id: string;
  readonly item_kind: string;
  /** Approved retrieval text, not a source transcript. */
  readonly text: string;
}

export interface RelatedAtomStructuredGenerationInputV1 {
  readonly model: string;
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly schema: { readonly [key: string]: unknown };
  readonly max_output_tokens: number;
  readonly timeout_ms: number;
  /** Optional opaque provenance for the provider transport only. */
  readonly transport?: StructuredGenerationTransportV1;
  readonly signal?: AbortSignal;
}

/** Provider-neutral structured-output seam. Composition owns its adapter and credentials. */
export interface RelatedAtomStructuredGenerationPortV1 {
  generate(input: RelatedAtomStructuredGenerationInputV1): Promise<unknown>;
}

/** Untyped canonical pair: `left_atom_id` is always lexicographically smaller. */
export interface RelatedAtomPairV1 {
  readonly left_atom_id: string;
  readonly right_atom_id: string;
}

export interface ProjectRelatedAtomsInputV1 {
  /** All atoms belong to one exact, already-authorized visibility segment. */
  readonly atoms: readonly ApprovedRetrievalAtomSummaryV1[];
  readonly model: string;
  readonly structured_output: RelatedAtomStructuredGenerationPortV1;
  readonly timeout_ms?: number;
  /** Supplied by a verified approved-snapshot witness when one is configured. */
  readonly transport?: StructuredGenerationTransportV1;
  readonly signal?: AbortSignal;
}

interface ProposedRelationshipV1 {
  readonly left_atom_id: string;
  readonly right_atom_id: string;
  readonly left_supporting_excerpt: string;
  readonly right_supporting_excerpt: string;
}

const RELATIONSHIP_SCHEMA_V1 = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["relationships"],
  properties: {
    relationships: {
      type: "array",
      maxItems: MAX_RELATED_ATOM_CANDIDATES_V1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "left_atom_id",
          "right_atom_id",
          "left_supporting_excerpt",
          "right_supporting_excerpt",
        ],
        properties: {
          left_atom_id: { type: "string", minLength: 1 },
          right_atom_id: { type: "string", minLength: 1 },
          left_supporting_excerpt: { type: "string", minLength: 1 },
          right_supporting_excerpt: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

const SYSTEM_PROMPT_V1 = `You project only material cross-record relationships between approved retrieval facts.

Each supplied atom is an approved retrieval summary from one exact visibility segment. Propose a relationship only when one fact materially depends on, qualifies, or defines a condition for the other fact. Do not infer a link from shared-word-only, customer-only, date-only, topic-only, or chronology-only overlap.

Every proposed endpoint must be an existing supplied atom ID. For each endpoint, return a non-empty exact excerpt copied verbatim from that endpoint's text which supports the material relationship. Do not invent IDs, paraphrase excerpts, create self-links, or connect facts from the same record. Return an empty relationships list when evidence is insufficient.`;

/** Automatically changes when the actual prompt, schema, or core bounds change. */
export const RELATED_ATOM_PROJECTOR_CORE_RELEASE_SHA256_V1 = canonicalSha256({
  schema_version: 1,
  kind: "echo-related-atom-projector-core-release-v1",
  system_prompt: SYSTEM_PROMPT_V1,
  response_schema: RELATIONSHIP_SCHEMA_V1,
  source_atom_limit: MAX_RELATED_ATOM_SOURCE_ATOMS_V1,
  source_text_utf8_bytes_limit: MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1,
  candidate_limit: MAX_RELATED_ATOM_CANDIDATES_V1,
  links_per_atom_limit: MAX_RELATED_ATOM_LINKS_PER_ATOM_V1,
  links_total_limit: MAX_RELATED_ATOM_LINKS_TOTAL_V1,
  minimum_supporting_excerpt_length:
    MIN_RELATED_ATOM_SUPPORTING_EXCERPT_LENGTH_V1,
  max_output_tokens: RELATED_ATOM_PROJECTOR_MAX_OUTPUT_TOKENS_V1,
});

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateAtoms(
  atoms: readonly ApprovedRetrievalAtomSummaryV1[],
): ReadonlyMap<string, ApprovedRetrievalAtomSummaryV1> {
  if (atoms.length > MAX_RELATED_ATOM_SOURCE_ATOMS_V1) {
    throw new RelatedAtomProjectorError("related atom source segment exceeds its bound");
  }
  const byId = new Map<string, ApprovedRetrievalAtomSummaryV1>();
  let aggregateTextBytes = 0;
  for (const atom of atoms) {
    if (
      !nonEmptyString(atom.atom_id) ||
      !nonEmptyString(atom.record_id) ||
      !nonEmptyString(atom.item_kind) ||
      !nonEmptyString(atom.text)
    ) {
      throw new RelatedAtomProjectorError("approved retrieval atom summary is invalid");
    }
    aggregateTextBytes += Buffer.byteLength(atom.text, "utf8");
    if (aggregateTextBytes > MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1) {
      throw new RelatedAtomProjectorError(
        "related atom source text exceeds its aggregate UTF-8 bound",
      );
    }
    if (byId.has(atom.atom_id)) {
      throw new RelatedAtomProjectorError("approved retrieval atom IDs must be unique");
    }
    byId.set(atom.atom_id, atom);
  }
  return byId;
}

function validateTimeout(timeoutMs: number | undefined): number {
  const chosen = timeoutMs ?? RELATED_ATOM_PROJECTOR_DEFAULT_TIMEOUT_MS_V1;
  if (
    !Number.isSafeInteger(chosen) ||
    chosen < 1 ||
    chosen > RELATED_ATOM_PROJECTOR_MAX_TIMEOUT_MS_V1
  ) {
    throw new RelatedAtomProjectorError("related atom projector timeout is invalid");
  }
  return chosen;
}

function parseResponse(value: unknown): readonly ProposedRelationshipV1[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RelatedAtomProjectorError("related atom projector response is invalid");
  }
  const relationships = (value as { readonly relationships?: unknown }).relationships;
  if (!Array.isArray(relationships) || relationships.length > MAX_RELATED_ATOM_CANDIDATES_V1) {
    throw new RelatedAtomProjectorError("related atom projector response is invalid");
  }
  return relationships.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return [];
    }
    const value = candidate as Partial<ProposedRelationshipV1>;
    return nonEmptyString(value.left_atom_id) &&
      nonEmptyString(value.right_atom_id) &&
      nonEmptyString(value.left_supporting_excerpt) &&
      nonEmptyString(value.right_supporting_excerpt)
      ? [
          {
            left_atom_id: value.left_atom_id,
            right_atom_id: value.right_atom_id,
            left_supporting_excerpt: value.left_supporting_excerpt,
            right_supporting_excerpt: value.right_supporting_excerpt,
          },
        ]
      : [];
  });
}

function canonicalPair(
  leftAtomId: string,
  rightAtomId: string,
): RelatedAtomPairV1 {
  return leftAtomId < rightAtomId
    ? Object.freeze({ left_atom_id: leftAtomId, right_atom_id: rightAtomId })
    : Object.freeze({ left_atom_id: rightAtomId, right_atom_id: leftAtomId });
}

function pairKey(pair: RelatedAtomPairV1): string {
  return JSON.stringify([pair.left_atom_id, pair.right_atom_id]);
}

function supportedCrossRecordPair(
  proposed: ProposedRelationshipV1,
  byId: ReadonlyMap<string, ApprovedRetrievalAtomSummaryV1>,
): RelatedAtomPairV1 | undefined {
  const left = byId.get(proposed.left_atom_id);
  const right = byId.get(proposed.right_atom_id);
  if (
    left === undefined ||
    right === undefined ||
    left.atom_id === right.atom_id ||
    left.record_id === right.record_id ||
    proposed.left_supporting_excerpt.trim().length <
      MIN_RELATED_ATOM_SUPPORTING_EXCERPT_LENGTH_V1 ||
    proposed.right_supporting_excerpt.trim().length <
      MIN_RELATED_ATOM_SUPPORTING_EXCERPT_LENGTH_V1 ||
    !left.text.includes(proposed.left_supporting_excerpt) ||
    !right.text.includes(proposed.right_supporting_excerpt)
  ) {
    return undefined;
  }
  return canonicalPair(left.atom_id, right.atom_id);
}

function boundedPairs(
  candidates: readonly RelatedAtomPairV1[],
): readonly RelatedAtomPairV1[] {
  const perAtom = new Map<string, number>();
  const accepted: RelatedAtomPairV1[] = [];
  for (const pair of candidates) {
    if (accepted.length >= MAX_RELATED_ATOM_LINKS_TOTAL_V1) {
      break;
    }
    if (
      (perAtom.get(pair.left_atom_id) ?? 0) >= MAX_RELATED_ATOM_LINKS_PER_ATOM_V1 ||
      (perAtom.get(pair.right_atom_id) ?? 0) >= MAX_RELATED_ATOM_LINKS_PER_ATOM_V1
    ) {
      continue;
    }
    accepted.push(pair);
    perAtom.set(pair.left_atom_id, (perAtom.get(pair.left_atom_id) ?? 0) + 1);
    perAtom.set(pair.right_atom_id, (perAtom.get(pair.right_atom_id) ?? 0) + 1);
  }
  return Object.freeze(accepted);
}

/**
 * Projects a bounded, untyped, cross-record adjacency list. Individual invalid
 * model candidates are ignored; a malformed response envelope fails closed.
 */
export async function projectRelatedAtomsV1(
  input: ProjectRelatedAtomsInputV1,
): Promise<readonly RelatedAtomPairV1[]> {
  if (!nonEmptyString(input.model)) {
    throw new RelatedAtomProjectorError("related atom projector model is invalid");
  }
  const byId = validateAtoms(input.atoms);
  if (input.atoms.length < 2) {
    return Object.freeze([]);
  }
  const response = await input.structured_output.generate({
    model: input.model,
    system_prompt: SYSTEM_PROMPT_V1,
    user_prompt: JSON.stringify({
      atoms: input.atoms.map((atom) => ({
        atom_id: atom.atom_id,
        record_id: atom.record_id,
        item_kind: atom.item_kind,
        text: atom.text,
      })),
    }),
    schema: RELATIONSHIP_SCHEMA_V1,
    max_output_tokens: RELATED_ATOM_PROJECTOR_MAX_OUTPUT_TOKENS_V1,
    timeout_ms: validateTimeout(input.timeout_ms),
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const unique = new Map<string, RelatedAtomPairV1>();
  for (const proposed of parseResponse(response)) {
    const pair = supportedCrossRecordPair(proposed, byId);
    if (pair !== undefined) {
      unique.set(pairKey(pair), pair);
    }
  }
  const sorted = [...unique.values()].sort((left, right) =>
    pairKey(left).localeCompare(pairKey(right)),
  );
  return boundedPairs(sorted);
}
import { canonicalSha256 } from "@echo-brain/federation-protocol";
