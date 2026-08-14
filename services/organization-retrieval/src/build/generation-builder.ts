import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  analyzeReadableSearchDocument,
} from '../application/analyzer.js';
import {
  type ReadableSearchAdmittedAtom,
  type ReadableSearchAdmittedGeneration,
  type ReadableSearchGenerationSegment,
  type ReadableSearchSegmentIdentity,
  type ReadableSearchStoppedBuildInput,
  type RetrievalContentAtom,
  type RetrievalLexicalDocument,
  type RetrievalPermissionFact,
  type RetrievalTermPosting,
  ORGANIZATION_MEMBER_POLICY_ID,
  RESTRICTED_REVIEWER_POLICY_ID,
  ReadableSearchValidationError,
} from '../application/contracts.js';
import {
  createReadableSearchGenerationManifest,
  createReadableSearchSegmentManifest,
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
import {
  organizationMemberSegmentIdentity,
  reviewerSegmentIdentity,
} from '../application/segment-identity.js';
import {
  assertReadableSearchDigest,
  assertReadableSearchIdentifier,
  assertReadableSearchRecordHead,
} from '../application/validation.js';
import { assertReadableSearchUpstreamInputBinding } from '../application/upstream-input.js';
import { ReadableSearchContentStore } from '../persistence/content-store.js';
import { ReadableSearchFactsStore } from '../persistence/facts-store.js';
import { ReadableSearchLexicalStore } from '../persistence/lexical-store.js';
import {
  READABLE_SEARCH_CONTENT_DATABASE,
  READABLE_SEARCH_FACTS_DATABASE,
  READABLE_SEARCH_LEXICAL_DATABASE,
  type ReadableSearchPlaneDefinition,
} from '../persistence/database-definition.js';
import { inspectReadableSearchPlane } from '../persistence/migrate.js';

const RETRIEVAL_DIRECTORY = 'record-retrieval';
const GENERATIONS_DIRECTORY = 'generations';
const SEGMENTS_DIRECTORY = 'segments';
const STAGING_DIRECTORY = /^\.staging-[0-9a-f]{32}$/;

interface BuiltSegment {
  readonly manifest: ReadableSearchGenerationSegment;
}

function ensurePrivateDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
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

function assertPrivateExistingDirectory(path: string, label: string): void {
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

function assertPrivateExistingFile(path: string, label: string): void {
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

function assertWithin(path: string, parent: string, label: string): void {
  const difference = relative(parent, path);
  if (difference === '' || difference === '..' || difference.startsWith('../')) {
    throw new Error(`${label} escapes its state directory`);
  }
}

function discardOrphanStaging(generations: string): void {
  for (const name of readdirSync(generations)) {
    if (!STAGING_DIRECTORY.test(name)) continue;
    const staging = join(generations, name);
    assertWithin(staging, generations, 'readable-search staging directory');
    ensurePrivateDirectory(staging, 'readable-search orphan staging directory');
    rmSync(staging, { recursive: true, force: false });
  }
}

function writePrivateFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function readonlyPlane(path: string, definition: ReadableSearchPlaneDefinition): Database.Database {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    resolve(path) !== path
  ) {
    throw new Error(`existing readable-search ${definition.plane} plane is unsafe`);
  }
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    database.pragma('trusted_schema = OFF');
    database.pragma('foreign_keys = ON');
    inspectReadableSearchPlane(database, definition);
    const metadata = database.prepare('SELECT finalized FROM retrieval_plane_metadata WHERE singleton = 1').get() as { finalized: number } | undefined;
    if (metadata?.finalized !== 1) throw new Error(`existing readable-search ${definition.plane} plane is not finalized`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function existingGeneration(
  path: string,
  generationsDirectory: string,
): ReadableSearchAdmittedGeneration {
  assertWithin(path, generationsDirectory, 'existing readable-search generation');
  if (dirname(path) !== generationsDirectory) {
    throw new Error('existing readable-search generation must be a direct child of generations');
  }
  assertPrivateExistingDirectory(path, 'existing readable-search generation');
  const manifestPath = join(path, 'manifest.json');
  const segmentsPath = join(path, SEGMENTS_DIRECTORY);
  assertPrivateExistingFile(manifestPath, 'existing readable-search generation manifest');
  assertPrivateExistingDirectory(segmentsPath, 'existing readable-search segment directory');
  const generationEntries = readdirSync(path).sort();
  if (
    generationEntries.length !== 2 ||
    generationEntries[0] !== 'manifest.json' ||
    generationEntries[1] !== SEGMENTS_DIRECTORY
  ) {
    throw new Error('existing readable-search generation has undeclared entries');
  }
  const bytes = readFileSync(manifestPath, 'utf8');
  const parsed = validateReadableSearchGenerationManifest(JSON.parse(bytes) as unknown);
  if (canonicalJson(parsed) !== bytes) {
    throw new Error('existing readable-search generation manifest is not canonical');
  }
  if (basename(path) !== parsed.generation_id) {
    throw new Error('existing readable-search generation directory disagrees with manifest identity');
  }
  const declaredSegmentIds = new Set<string>(
    parsed.segments.map((entry) => entry.segment_id),
  );
  const actualSegmentIds = readdirSync(segmentsPath);
  if (
    actualSegmentIds.length !== declaredSegmentIds.size ||
    actualSegmentIds.some((segmentId) => !declaredSegmentIds.has(segmentId))
  ) {
    throw new Error('existing readable-search generation has undeclared segments');
  }
  for (const entry of parsed.segments) {
    const directory = join(segmentsPath, entry.segment_id);
    assertPrivateExistingDirectory(directory, 'existing readable-search segment');
    const segmentManifestPath = join(directory, 'segment-manifest.json');
    const factsPath = join(directory, 'facts.sqlite');
    const lexicalPath = join(directory, 'lexical.sqlite');
    const contentPath = join(directory, 'content.sqlite');
    const segmentEntries = readdirSync(directory).sort();
    const expectedSegmentEntries = [
      'content.sqlite',
      'facts.sqlite',
      'lexical.sqlite',
      'segment-manifest.json',
    ];
    if (
      segmentEntries.length !== expectedSegmentEntries.length ||
      segmentEntries.some((value, index) => value !== expectedSegmentEntries[index])
    ) {
      throw new Error('existing readable-search segment has undeclared entries');
    }
    assertPrivateExistingFile(segmentManifestPath, 'existing readable-search segment manifest');
    assertPrivateExistingFile(factsPath, 'existing readable-search facts plane');
    assertPrivateExistingFile(lexicalPath, 'existing readable-search lexical plane');
    assertPrivateExistingFile(contentPath, 'existing readable-search content plane');
    const segmentBytes = readFileSync(segmentManifestPath, 'utf8');
    const segment = validateReadableSearchSegmentManifest(JSON.parse(segmentBytes) as unknown);
    if (
      canonicalJson(segment) !== segmentBytes ||
      readableSearchSegmentManifestSha256(segment) !== entry.segment_manifest_sha256
    ) {
      throw new Error('existing readable-search segment manifest is invalid');
    }
    const facts = readonlyPlane(factsPath, READABLE_SEARCH_FACTS_DATABASE);
    const lexical = readonlyPlane(lexicalPath, READABLE_SEARCH_LEXICAL_DATABASE);
    const content = readonlyPlane(contentPath, READABLE_SEARCH_CONTENT_DATABASE);
    try {
      const factRows = facts.prepare('SELECT * FROM retrieval_permission_fact ORDER BY log_position, atom_order, atom_id').all() as RetrievalPermissionFact[];
      const contentRows = content.prepare('SELECT * FROM retrieval_content_atom ORDER BY log_position, atom_order, atom_id').all() as RetrievalContentAtom[];
      const documents = lexical.prepare('SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id').all() as RetrievalLexicalDocument[];
      const postings = lexical.prepare('SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id').all() as RetrievalTermPosting[];
      if (
        factRows.length !== segment.fact_count ||
        contentRows.length !== segment.content_count ||
        documents.length !== segment.document_count ||
        postings.length !== segment.posting_count ||
        readableSearchFactsRoot(segment.segment_id, factRows) !== entry.facts_root ||
        readableSearchContentRoot(segment.segment_id, contentRows) !== entry.content_root ||
        readableSearchLexicalRoot({ segment_id: segment.segment_id, documents, postings }) !== entry.lexical_root
      ) {
        throw new Error('existing readable-search generation root validation failed');
      }
    } finally {
      facts.close();
      lexical.close();
      content.close();
    }
  }
  if (
    readableSearchGenerationPlaneRoot({ plane: 'facts', segments: parsed.segments }) !== parsed.roots.facts_root ||
    readableSearchGenerationPlaneRoot({ plane: 'content', segments: parsed.segments }) !== parsed.roots.content_root ||
    readableSearchGenerationPlaneRoot({ plane: 'lexical', segments: parsed.segments }) !== parsed.roots.lexical_root
  ) {
    throw new Error('existing readable-search generation roots are invalid');
  }
  return Object.freeze({
    generation_directory: path,
    manifest: parsed,
    manifest_sha256: readableSearchGenerationManifestSha256(parsed),
  });
}

function identityForAtom(
  atom: ReadableSearchAdmittedAtom,
  input: ReadableSearchStoppedBuildInput,
): ReadableSearchSegmentIdentity {
  const { fact } = atom;
  if (fact.organization_id !== input.organization_id) {
    throw new ReadableSearchValidationError('admitted atom organization disagrees with build input');
  }
  if (fact.policy_id === ORGANIZATION_MEMBER_POLICY_ID) {
    if (
      fact.policy_contract_sha256 !== input.organization_member_policy_contract_sha256 ||
      fact.reviewer_principal_id !== null ||
      fact.reviewer_membership_id !== null
    ) {
      throw new ReadableSearchValidationError('organization-member admitted atom has an invalid policy branch');
    }
    return organizationMemberSegmentIdentity({
      organization_id: input.organization_id,
      policy_contract_sha256: input.organization_member_policy_contract_sha256,
    });
  }
  if (fact.policy_id === RESTRICTED_REVIEWER_POLICY_ID) {
    if (
      fact.policy_contract_sha256 !== input.restricted_reviewer_policy_contract_sha256 ||
      fact.reviewer_principal_id === null ||
      fact.reviewer_membership_id === null
    ) {
      throw new ReadableSearchValidationError('reviewer admitted atom has an invalid policy branch');
    }
    return reviewerSegmentIdentity({
      organization_id: input.organization_id,
      policy_contract_sha256: input.restricted_reviewer_policy_contract_sha256,
      reviewer_principal_id: fact.reviewer_principal_id,
      reviewer_membership_id: fact.reviewer_membership_id,
    });
  }
  throw new ReadableSearchValidationError('admitted atom policy is unsupported');
}

function buildOneSegment(
  stagingDirectory: string,
  identity: ReadableSearchSegmentIdentity,
  atoms: readonly ReadableSearchAdmittedAtom[],
  input: ReadableSearchStoppedBuildInput,
): BuiltSegment {
  const segmentDirectory = join(stagingDirectory, SEGMENTS_DIRECTORY, identity.segment_id);
  ensurePrivateDirectory(segmentDirectory, 'readable-search segment directory');
  const facts = ReadableSearchFactsStore.open(join(segmentDirectory, 'facts.sqlite'));
  const content = ReadableSearchContentStore.open(join(segmentDirectory, 'content.sqlite'));
  const lexical = ReadableSearchLexicalStore.open(join(segmentDirectory, 'lexical.sqlite'));
  try {
    const metadata = { ...identity, analyzer_contract_sha256: input.analyzer.analyzer_contract_sha256 };
    facts.initialize(metadata);
    content.initialize(metadata);
    lexical.initialize(metadata);
    for (const atom of atoms) {
      const { fact } = atom;
      if (sha256Digest(atom.text) !== atom.text_sha256) {
        throw new ReadableSearchValidationError('admitted atom text does not bind text_sha256');
      }
      facts.insert(fact);
      content.insert({
        atom_id: fact.atom_id,
        log_position: fact.log_position,
        record_hash: fact.record_hash,
        atom_order: fact.atom_order,
        item_kind: fact.item_kind,
        text: atom.text,
        text_sha256: atom.text_sha256,
        content_binding_sha256: fact.content_binding_sha256,
        provenance_binding_sha256: fact.provenance_binding_sha256,
      });
      lexical.insertDocument({
        atom_id: fact.atom_id,
        log_position: fact.log_position,
        atom_order: fact.atom_order,
        content_binding_sha256: fact.content_binding_sha256,
      });
      for (const [term, termFrequency] of analyzeReadableSearchDocument(atom.text)) {
        lexical.insertPosting({ term, atom_id: fact.atom_id, term_frequency: termFrequency });
      }
    }
    const factRows = facts.rows();
    const contentRows = content.rows();
    const documents = lexical.documents();
    const postings = lexical.postings();
    const factsRoot = readableSearchFactsRoot(identity.segment_id, factRows);
    const contentRoot = readableSearchContentRoot(identity.segment_id, contentRows);
    const lexicalRoot = readableSearchLexicalRoot({
      segment_id: identity.segment_id,
      documents,
      postings,
    });
    facts.finalize();
    content.finalize();
    lexical.finalize();
    const segmentManifest = createReadableSearchSegmentManifest({
      ...identity,
      analyzer_contract_sha256: input.analyzer.analyzer_contract_sha256,
      facts_root: factsRoot,
      content_root: contentRoot,
      lexical_root: lexicalRoot,
      fact_count: factRows.length,
      content_count: contentRows.length,
      document_count: documents.length,
      posting_count: postings.length,
    });
    writePrivateFile(join(segmentDirectory, 'segment-manifest.json'), canonicalJson(segmentManifest));
    syncDirectory(segmentDirectory);
    return Object.freeze({
      manifest: Object.freeze({
        segment_id: identity.segment_id,
        segment_manifest_sha256: readableSearchSegmentManifestSha256(segmentManifest),
        facts_root: factsRoot,
        content_root: contentRoot,
        lexical_root: lexicalRoot,
      }),
    });
  } finally {
    facts.close();
    content.close();
    lexical.close();
  }
}

/**
 * Builds from a complete, already verified Layer 1 snapshot. Nothing from the
 * Authority or record workspaces is imported here; callers own that boundary.
 */
export function buildStoppedReadableSearchGeneration(
  input: ReadableSearchStoppedBuildInput,
): ReadableSearchAdmittedGeneration {
  const stateDirectory = assertReadableSearchIdentifier(input.state_directory, 'state_directory');
  if (!stateDirectory.startsWith('/')) throw new ReadableSearchValidationError('state_directory must be absolute');
  const organizationId = assertReadableSearchIdentifier(input.organization_id, 'organization_id');
  const recordHead = assertReadableSearchRecordHead(input.record_head, 'record_head');
  const retrievalContract = assertReadableSearchDigest(input.retrieval_contract_sha256, 'retrieval_contract_sha256');
  const memberContract = assertReadableSearchDigest(input.organization_member_policy_contract_sha256, 'organization member policy contract');
  const reviewerContract = assertReadableSearchDigest(input.restricted_reviewer_policy_contract_sha256, 'reviewer policy contract');
  const upstreamInputRoot = assertReadableSearchUpstreamInputBinding(input);
  const root = join(stateDirectory, RETRIEVAL_DIRECTORY);
  const generations = join(root, GENERATIONS_DIRECTORY);
  ensurePrivateDirectory(stateDirectory, 'readable-search state directory');
  ensurePrivateDirectory(root, 'readable-search state root');
  ensurePrivateDirectory(generations, 'readable-search generations directory');
  discardOrphanStaging(generations);
  const staging = join(generations, `.staging-${randomBytes(16).toString('hex')}`);
  assertWithin(staging, generations, 'readable-search staging directory');
  mkdirSync(staging, { mode: 0o700 });
  try {
    ensurePrivateDirectory(join(staging, SEGMENTS_DIRECTORY), 'readable-search staging segments directory');
    const seenAtoms = new Set<string>();
    const grouped = new Map<string, { identity: ReadableSearchSegmentIdentity; atoms: ReadableSearchAdmittedAtom[] }>();
    const organizationIdentity = organizationMemberSegmentIdentity({
      organization_id: organizationId,
      policy_contract_sha256: memberContract,
    });
    grouped.set(organizationIdentity.segment_id, { identity: organizationIdentity, atoms: [] });
    for (const atom of input.atoms) {
      if (seenAtoms.has(atom.fact.atom_id)) {
        throw new ReadableSearchValidationError('duplicate atom identity across retrieval segments');
      }
      seenAtoms.add(atom.fact.atom_id);
      const identity = identityForAtom(atom, { ...input, organization_id: organizationId, organization_member_policy_contract_sha256: memberContract, restricted_reviewer_policy_contract_sha256: reviewerContract });
      const current = grouped.get(identity.segment_id);
      if (current === undefined) grouped.set(identity.segment_id, { identity, atoms: [atom] });
      else current.atoms.push(atom);
    }
    const segments: ReadableSearchGenerationSegment[] = [];
    for (const group of [...grouped.values()].sort((left, right) => Buffer.compare(Buffer.from(left.identity.segment_id), Buffer.from(right.identity.segment_id)))) {
      segments.push(buildOneSegment(staging, group.identity, group.atoms, input).manifest);
    }
    const manifest = createReadableSearchGenerationManifest({
      organization_id: organizationId,
      retrieval_contract_sha256: retrievalContract,
      source_revision: input.source_revision,
      builder_artifact_sha256: input.builder_artifact_sha256,
      input_contract_version: 1,
      policies: [
        { policy_id: ORGANIZATION_MEMBER_POLICY_ID, policy_contract_sha256: memberContract },
        { policy_id: RESTRICTED_REVIEWER_POLICY_ID, policy_contract_sha256: reviewerContract },
      ],
      record_head: recordHead,
      input_cursor: recordHead,
      upstream_input_root: upstreamInputRoot,
      roots: {
        facts_root: readableSearchGenerationPlaneRoot({ plane: 'facts', segments }),
        content_root: readableSearchGenerationPlaneRoot({ plane: 'content', segments }),
        lexical_root: readableSearchGenerationPlaneRoot({ plane: 'lexical', segments }),
      },
      segments,
      analyzer: input.analyzer,
      index: { format_version: 1, sqlite_version: input.sqlite_version },
    });
    writePrivateFile(join(staging, 'manifest.json'), canonicalJson(manifest));
    syncDirectory(staging);
    const finalDirectory = join(generations, manifest.generation_id);
    if (existsSync(finalDirectory)) {
      const existing = existingGeneration(finalDirectory, generations);
      if (existing.manifest_sha256 !== readableSearchGenerationManifestSha256(manifest)) {
        throw new Error('existing readable-search generation differs under the same identity');
      }
      rmSync(staging, { recursive: true, force: true });
      return existing;
    }
    renameSync(staging, finalDirectory);
    syncDirectory(generations);
    return Object.freeze({
      generation_directory: finalDirectory,
      manifest,
      manifest_sha256: readableSearchGenerationManifestSha256(manifest),
    });
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
