import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  type ReadableSearchAdmittedGeneration,
  type ReadableSearchGenerationAdmissionInput,
  type ReadableSearchGenerationManifest,
  type ReadableSearchPlaneMetadata,
  type ReadableSearchSegmentManifest,
  type RetrievalContentAtom,
  type RetrievalLexicalDocument,
  type RetrievalPermissionFact,
  type RetrievalTermPosting,
} from '../application/contracts.js';
import { organizationMemberSegmentIdentity } from '../application/segment-identity.js';
import {
  readableSearchGenerationManifestSha256,
  readableSearchSegmentManifestSha256,
  validateReadableSearchGenerationManifest,
  validateReadableSearchSegmentManifest,
} from '../application/manifests.js';
import {
  readableSearchContentRoot,
  readableSearchFactsRoot,
  readableSearchGenerationPlaneRoot,
  readableSearchLexicalRoot,
} from '../application/roots.js';
import { assertReadableSearchRecordHead } from '../application/validation.js';
import {
  READABLE_SEARCH_CONTENT_DATABASE,
  READABLE_SEARCH_FACTS_DATABASE,
  READABLE_SEARCH_LEXICAL_DATABASE,
  type ReadableSearchPlaneDefinition,
} from '../persistence/database-definition.js';
import { inspectReadableSearchPlane } from '../persistence/migrate.js';

export interface AdmittedReadableSearchSegment {
  readonly manifest: ReadableSearchSegmentManifest;
  /** The generation manifest commits to this exact segment manifest. */
  readonly segment_manifest_sha256: string;
  readonly directory: string;
  readonly facts_path: string;
  readonly lexical_path: string;
  readonly content_path: string;
  readonly facts_identity: ReadableSearchImmutableFileIdentity;
  readonly lexical_identity: ReadableSearchImmutableFileIdentity;
  readonly content_identity: ReadableSearchImmutableFileIdentity;
}

/** Immutable file identity pinned only by complete generation admission. */
export interface ReadableSearchImmutableFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtime_ms: number;
  readonly ctime_ms: number;
  readonly sha256: string;
}

/** Test seam for deterministically exercising the path-swap window. */
export interface OpenAdmittedReadableSearchPlaneOptions {
  readonly open_database?: (path: string) => Database.Database;
  readonly validate_opened?: (database: Database.Database) => void;
}

export interface OpenedReadableSearchGeneration extends ReadableSearchAdmittedGeneration {
  readonly segments: ReadonlyMap<string, AdmittedReadableSearchSegment>;
}

function assertPrivateFile(path: string, label: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} must be a current-user 0600 canonical file`);
  }
}

function immutableFileIdentity(
  path: string,
  label: string,
): ReadableSearchImmutableFileIdentity {
  assertPrivateFile(path, label);
  const state = lstatSync(path);
  const bytes = readFileSync(path);
  return Object.freeze({
    dev: state.dev,
    ino: state.ino,
    size: state.size,
    mtime_ms: state.mtimeMs,
    ctime_ms: state.ctimeMs,
    sha256: sha256Digest(bytes),
  });
}

function sameImmutableFileIdentity(
  left: ReadableSearchImmutableFileIdentity,
  right: ReadableSearchImmutableFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtime_ms === right.mtime_ms &&
    left.ctime_ms === right.ctime_ms &&
    left.sha256 === right.sha256
  );
}

function assertPrivateDirectory(path: string, label: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o700 ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} must be a current-user 0700 canonical directory`);
  }
}

function readCanonicalJson(path: string, label: string): unknown {
  assertPrivateFile(path, label);
  const bytes = readFileSync(path, 'utf8');
  const parsed = JSON.parse(bytes) as unknown;
  if (canonicalJson(parsed) !== bytes) throw new Error(`${label} is not canonical JSON`);
  return parsed;
}

function openReadonlyPlane(
  path: string,
  definition: ReadableSearchPlaneDefinition,
  expectedIdentity?: ReadableSearchImmutableFileIdentity,
  options?: OpenAdmittedReadableSearchPlaneOptions,
): Database.Database {
  assertPrivateFile(path, `readable-search ${definition.plane} plane`);
  if (
    expectedIdentity !== undefined &&
    !sameImmutableFileIdentity(
      immutableFileIdentity(path, `readable-search ${definition.plane} plane`),
      expectedIdentity,
    )
  ) {
    throw new Error(`readable-search ${definition.plane} plane differs from admitted immutable identity`);
  }
  const database = options?.open_database?.(path) ?? new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (
      expectedIdentity !== undefined &&
      !sameImmutableFileIdentity(
        immutableFileIdentity(path, `readable-search ${definition.plane} plane`),
        expectedIdentity,
      )
    ) {
      throw new Error(`readable-search ${definition.plane} plane changed while opening`);
    }
    database.pragma('trusted_schema = OFF');
    database.pragma('foreign_keys = ON');
    inspectReadableSearchPlane(database, definition);
    options?.validate_opened?.(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Opens one admission-pinned plane, never a general generation path. */
export function openAdmittedReadableSearchPlane(
  path: string,
  definition: ReadableSearchPlaneDefinition,
  expectedIdentity: ReadableSearchImmutableFileIdentity,
  options?: OpenAdmittedReadableSearchPlaneOptions,
): Database.Database {
  return openReadonlyPlane(path, definition, expectedIdentity, options);
}

interface RawPlaneMetadata extends Omit<ReadableSearchPlaneMetadata, 'finalized'> {
  readonly finalized: 0 | 1;
}

function metadata(database: Database.Database): ReadableSearchPlaneMetadata {
  const row = database.prepare(
    `SELECT schema_version, plane, organization_id, segment_id, segment_kind,
            policy_id, policy_contract_sha256, reviewer_principal_id, reviewer_membership_id,
            analyzer_contract_sha256, finalized
     FROM retrieval_plane_metadata WHERE singleton = 1`,
  ).get() as RawPlaneMetadata | undefined;
  if (row === undefined || row.schema_version !== 1 || row.finalized !== 1) {
    throw new Error('readable-search plane metadata is incomplete or unfinalized');
  }
  return Object.freeze({ ...row, finalized: true });
}

function assertPlaneMatchesSegment(
  metadataRow: ReadableSearchPlaneMetadata,
  segment: ReadableSearchSegmentManifest,
): void {
  if (
    metadataRow.organization_id !== segment.organization_id ||
    metadataRow.segment_id !== segment.segment_id ||
    metadataRow.segment_kind !== segment.segment_kind ||
    metadataRow.policy_id !== segment.policy_id ||
    metadataRow.policy_contract_sha256 !== segment.policy_contract_sha256 ||
    metadataRow.reviewer_principal_id !== segment.reviewer_principal_id ||
    metadataRow.reviewer_membership_id !== segment.reviewer_membership_id ||
    metadataRow.analyzer_contract_sha256 !== segment.analyzer_contract_sha256
  ) {
    throw new Error('readable-search plane metadata does not match its segment manifest');
  }
}

function readSegment(
  generationDirectory: string,
  entry: ReadableSearchGenerationManifest['segments'][number],
): AdmittedReadableSearchSegment {
  const directory = join(generationDirectory, 'segments', entry.segment_id);
  assertPrivateDirectory(directory, 'readable-search segment directory');
  const segmentPath = join(directory, 'segment-manifest.json');
  const segment = validateReadableSearchSegmentManifest(readCanonicalJson(segmentPath, 'readable-search segment manifest'));
  if (readableSearchSegmentManifestSha256(segment) !== entry.segment_manifest_sha256) {
    throw new Error('readable-search segment manifest digest mismatch');
  }
  if (
    segment.segment_id !== entry.segment_id ||
    segment.facts_root !== entry.facts_root ||
    segment.content_root !== entry.content_root ||
    segment.lexical_root !== entry.lexical_root
  ) {
    throw new Error('readable-search generation segment binding mismatch');
  }
  const factsPath = join(directory, 'facts.sqlite');
  const lexicalPath = join(directory, 'lexical.sqlite');
  const contentPath = join(directory, 'content.sqlite');
  const factsIdentity = immutableFileIdentity(factsPath, 'readable-search facts plane');
  const lexicalIdentity = immutableFileIdentity(lexicalPath, 'readable-search lexical plane');
  const contentIdentity = immutableFileIdentity(contentPath, 'readable-search content plane');
  const facts = openReadonlyPlane(factsPath, READABLE_SEARCH_FACTS_DATABASE);
  const lexical = openReadonlyPlane(lexicalPath, READABLE_SEARCH_LEXICAL_DATABASE);
  const content = openReadonlyPlane(contentPath, READABLE_SEARCH_CONTENT_DATABASE);
  try {
    assertPlaneMatchesSegment(metadata(facts), segment);
    assertPlaneMatchesSegment(metadata(lexical), segment);
    assertPlaneMatchesSegment(metadata(content), segment);
    const factRows = facts.prepare('SELECT * FROM retrieval_permission_fact ORDER BY log_position, atom_order, atom_id').all() as RetrievalPermissionFact[];
    const contentRows = content.prepare('SELECT * FROM retrieval_content_atom ORDER BY log_position, atom_order, atom_id').all() as RetrievalContentAtom[];
    const documents = lexical.prepare('SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id').all() as RetrievalLexicalDocument[];
    const postings = lexical.prepare('SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id').all() as RetrievalTermPosting[];
    if (
      factRows.length !== segment.fact_count ||
      contentRows.length !== segment.content_count ||
      documents.length !== segment.document_count ||
      postings.length !== segment.posting_count ||
      readableSearchFactsRoot(segment.segment_id, factRows) !== segment.facts_root ||
      readableSearchContentRoot(segment.segment_id, contentRows) !== segment.content_root ||
      readableSearchLexicalRoot({ segment_id: segment.segment_id, documents, postings }) !== segment.lexical_root
    ) {
      throw new Error('readable-search segment plane roots or counts are invalid');
    }
    const contentByAtom = new Map(contentRows.map((row) => [row.atom_id, row]));
    const documentByAtom = new Map(documents.map((row) => [row.atom_id, row]));
    for (const fact of factRows) {
      const contentAtom = contentByAtom.get(fact.atom_id);
      const document = documentByAtom.get(fact.atom_id);
      if (
        contentAtom === undefined || document === undefined ||
        contentAtom.log_position !== fact.log_position ||
        contentAtom.record_hash !== fact.record_hash ||
        contentAtom.atom_order !== fact.atom_order ||
        contentAtom.item_kind !== fact.item_kind ||
        contentAtom.content_binding_sha256 !== fact.content_binding_sha256 ||
        contentAtom.provenance_binding_sha256 !== fact.provenance_binding_sha256 ||
        document.log_position !== fact.log_position ||
        document.atom_order !== fact.atom_order ||
        document.content_binding_sha256 !== fact.content_binding_sha256
      ) {
        throw new Error('readable-search segment fact/content/lexical binding mismatch');
      }
    }
    if (contentByAtom.size !== factRows.length || documentByAtom.size !== factRows.length) {
      throw new Error('readable-search segment has unbound content or lexical rows');
    }
  return Object.freeze({
    manifest: segment,
    segment_manifest_sha256: entry.segment_manifest_sha256,
    directory,
      facts_path: factsPath,
      lexical_path: lexicalPath,
      content_path: contentPath,
      facts_identity: factsIdentity,
      lexical_identity: lexicalIdentity,
      content_identity: contentIdentity,
    });
  } finally {
    facts.close();
    lexical.close();
    content.close();
  }
}

export function admitReadableSearchGenerationDirectory(input: {
  readonly generation_directory: string;
  readonly admission: ReadableSearchGenerationAdmissionInput;
}): OpenedReadableSearchGeneration {
  const { generation_directory: generationDirectory, admission } = input;
  const generationsDirectory = join(admission.state_directory, 'record-retrieval', 'generations');
  assertPrivateDirectory(generationsDirectory, 'readable-search generations directory');
  const difference = relative(generationsDirectory, generationDirectory);
  if (difference === '' || difference === '..' || difference.startsWith('../')) {
    throw new Error('readable-search generation directory escapes its state root');
  }
  if (dirname(generationDirectory) !== generationsDirectory) {
    throw new Error('readable-search generation directory must be a direct state-root child');
  }
  assertPrivateDirectory(generationDirectory, 'readable-search generation directory');
  const manifestPath = join(generationDirectory, 'manifest.json');
  const manifest = validateReadableSearchGenerationManifest(readCanonicalJson(manifestPath, 'readable-search generation manifest'));
  if (
    manifest.organization_id !== admission.organization_id ||
    manifest.retrieval_contract_sha256 !== admission.retrieval_contract_sha256 ||
    manifest.record_head.position !== assertReadableSearchRecordHead(admission.record_head, 'admission record_head').position ||
    manifest.record_head.record_hash !== admission.record_head.record_hash ||
    canonicalJson(manifest.analyzer) !== canonicalJson(admission.analyzer)
  ) {
    throw new Error('readable-search generation does not match its admission pin');
  }
  const segmentDirectory = join(generationDirectory, 'segments');
  assertPrivateDirectory(segmentDirectory, 'readable-search segments directory');
  const generationEntries = readdirSync(generationDirectory).sort();
  if (
    generationEntries.length !== 2 ||
    generationEntries[0] !== 'manifest.json' ||
    generationEntries[1] !== 'segments'
  ) {
    throw new Error('readable-search generation has undeclared entries');
  }
  if (basename(generationDirectory) !== manifest.generation_id) {
    throw new Error('readable-search generation directory disagrees with manifest identity');
  }
  const declaredSegmentIds = new Set<string>(manifest.segments.map((segment) => segment.segment_id));
  const actualSegmentIds = readdirSync(segmentDirectory);
  if (
    actualSegmentIds.length !== declaredSegmentIds.size ||
    actualSegmentIds.some((segmentId) => !declaredSegmentIds.has(segmentId))
  ) {
    throw new Error('readable-search generation has mixed or undeclared segments');
  }
  const segments = new Map<string, AdmittedReadableSearchSegment>();
  const seenAtoms = new Set<string>();
  for (const entry of manifest.segments) {
    const segment = readSegment(generationDirectory, entry);
    if (segments.has(segment.manifest.segment_id)) throw new Error('readable-search generation duplicates a segment');
    const facts = readFactsForAdmission(segment.facts_path);
    for (const fact of facts) {
      if (seenAtoms.has(fact.atom_id)) throw new Error('readable-search generation duplicates an atom across segments');
      seenAtoms.add(fact.atom_id);
    }
    segments.set(segment.manifest.segment_id, segment);
  }
  const memberPolicy = manifest.policies.find(
    (policy) => policy.policy_id === 'organization-member-readable-v1',
  );
  if (memberPolicy === undefined) throw new Error('readable-search member policy is missing');
  const organizationSegment = organizationMemberSegmentIdentity({
    organization_id: manifest.organization_id,
    policy_contract_sha256: memberPolicy.policy_contract_sha256,
  });
  if (!segments.has(organizationSegment.segment_id)) {
    throw new Error('readable-search generation omits its required member segment');
  }
  const entries = [...segments.values()].map((segment) => ({
    segment_id: segment.manifest.segment_id,
    segment_manifest_sha256: readableSearchSegmentManifestSha256(segment.manifest),
    facts_root: segment.manifest.facts_root,
    content_root: segment.manifest.content_root,
    lexical_root: segment.manifest.lexical_root,
  }));
  if (
    readableSearchGenerationPlaneRoot({ plane: 'facts', segments: entries }) !== manifest.roots.facts_root ||
    readableSearchGenerationPlaneRoot({ plane: 'content', segments: entries }) !== manifest.roots.content_root ||
    readableSearchGenerationPlaneRoot({ plane: 'lexical', segments: entries }) !== manifest.roots.lexical_root
  ) {
    throw new Error('readable-search generation roots are invalid');
  }
  return Object.freeze({
    generation_directory: generationDirectory,
    manifest,
    manifest_sha256: readableSearchGenerationManifestSha256(manifest),
    segments,
  });
}

/** The serving machine calls this only after a scope has been bound. */
export function readFactsForAdmission(
  path: string,
  expectedIdentity?: ReadableSearchImmutableFileIdentity,
): readonly RetrievalPermissionFact[] {
  const database = openReadonlyPlane(
    path,
    READABLE_SEARCH_FACTS_DATABASE,
    expectedIdentity,
  );
  try {
    return Object.freeze(
      (database.prepare(
        'SELECT * FROM retrieval_permission_fact ORDER BY log_position, atom_order, atom_id',
      ).all() as RetrievalPermissionFact[]).map((fact) => Object.freeze({ ...fact })),
    );
  } finally {
    database.close();
  }
}
