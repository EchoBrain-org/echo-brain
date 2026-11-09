import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V7,
  personAnswerCitationKeyV8,
  validatePersonAnswerCitationV6,
  validatePersonAnswerCitationV8,
  validatePersonAnswerResponseV8,
  validatePersonEvidenceOpenRequestV1,
} from '../src/index.js';

const record = `sha256:${'a'.repeat(64)}` as const;
const atom = `sha256:${'b'.repeat(64)}` as const;
const documentId = `doc_${'1'.repeat(64)}`;
const itemId = 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const membershipId = 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const source = {
  kind: 'source_revision', source_id: `source:${'d'.repeat(64)}`, revision_id: 'revision-1',
  source_sha256: `sha256:${'e'.repeat(64)}`, representation_sha256: `sha256:${'f'.repeat(64)}`, anchor_sha256: `sha256:${'0'.repeat(64)}`,
};
const note = { ...source, revision_id: 'revision-2' };
const ticket = {
  kind: 'ticket', tool_id: 'jira', external_scope_id: '11111111-1111-4111-8111-111111111111', ticket_id: '10001',
  permalink: 'https://fixture.atlassian.net/browse/ECHO-1', text_sha256: sha256Digest('ECHO-1: Launch is Tuesday.'),
};
const page = {
  kind: 'page', tool_id: 'knowledge', external_scope_id: 'site-123', page_id: 'page-456', section_id: 's2', version: '42',
  permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=456', text_sha256: canonicalSha256('Launch is Tuesday.'),
};
const container = {
  kind: 'tool_container', tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project', container_id: '10001',
  permalink: 'https://example.atlassian.net/browse/THERM',
};
type Cited = { readonly citation: Record<string, unknown>; readonly kind: string; readonly label: string; readonly visibility: string; readonly ref?: string; readonly key?: string };

/**
 * One row per citation kind: a valid answer citation (with the ref it must carry), the first citation version that
 * admits it (4 the evidence desk, 6 impact cards, 8 answers only), whether it is named by its own kind, the ref that
 * opens its item and one naming another item, what a missing required ref fails with, the same identity cited again,
 * and its key.
 */
interface Row {
  readonly name: string; readonly cited: Cited; readonly since: 4 | 6 | 8; readonly named: boolean;
  readonly ref?: string; readonly other_ref?: string; readonly missing?: string; readonly again: Partial<Cited>; readonly key: string;
}
const ROWS: readonly Row[] = [
  {
    name: 'approved record', since: 4, named: false,
    cited: { citation: { kind: 'approved_record', atom_id: atom, record_sha256: record, policy_id: 'project-members-readable-person-v1' }, kind: 'decision', label: 'Ship fan curve v2', visibility: 'team' },
    ref: `meeting:${record}`, other_ref: `meeting:sha256:${'9'.repeat(64)}`, again: { label: 'Again' }, key: `approved_record:${atom}`,
  },
  {
    name: 'document passage', since: 4, named: false,
    cited: { citation: { ...source, document_id: documentId }, kind: 'document_passage', label: 'MRD', visibility: 'team' },
    ref: `document:${documentId}`, other_ref: `document:doc_${'3'.repeat(64)}`, again: { label: 'Again' },
    key: `source_revision:${source.source_id}:revision-1:${source.representation_sha256}:${source.anchor_sha256}`,
  },
  {
    name: 'note passage', since: 4, named: false,
    cited: { citation: note, kind: 'note', label: 'Private note', visibility: 'only_me' },
    ref: `note:ctx_${'2'.repeat(64)}`, again: { label: 'Again' },
    key: `source_revision:${source.source_id}:revision-2:${source.representation_sha256}:${source.anchor_sha256}`,
  },
  // A ticket's released text is not part of its identity: a listed ticket's row and its opened body are one citation.
  {
    name: 'ticket', since: 6, named: true, cited: { citation: ticket, kind: 'ticket', label: 'ECHO-1: Launch', visibility: 'only_me' },
    again: { citation: { ...ticket, text_sha256: canonicalSha256('new revision') } }, key: `ticket:jira:${ticket.external_scope_id}:10001`,
  },
  {
    name: 'page', since: 6, named: true, cited: { citation: page, kind: 'page', label: 'Launch plan', visibility: 'only_me' },
    again: { citation: { ...page, text_sha256: canonicalSha256('changed') } }, key: 'page:knowledge:site-123:page-456:s2:42',
  },
  {
    name: 'follow-up', since: 8, named: true,
    cited: { citation: { kind: 'follow_up', item_id: itemId }, kind: 'follow_up', label: 'THERM-48 Fan curve v2', visibility: 'team', ref: `follow_up:${itemId}` },
    ref: `follow_up:${itemId}`, other_ref: `follow_up:itm_${'0'.repeat(8)}`, missing: 'Follow-up citation ref is missing', again: { label: 'Again' }, key: `follow_up:${itemId}`,
  },
  {
    name: 'project', since: 8, named: true,
    cited: { citation: { kind: 'project', project_id: projectId }, kind: 'project', label: 'Thermal recovery', visibility: 'project', ref: `project:${projectId}` },
    ref: `project:${projectId}`, other_ref: 'project:prj_00000000-0000-4000-8000-000000000000', missing: 'Workspace citation ref is missing', again: { label: 'Thermal' },
    key: `project:${projectId}`,
  },
  {
    name: 'person', since: 8, named: true, cited: { citation: { kind: 'person', membership_id: membershipId }, kind: 'person', label: 'Mara Lind', visibility: 'team' },
    again: { label: 'Mara' }, key: `person:${membershipId}`,
  },
  {
    name: 'tool', since: 8, named: true, cited: { citation: { kind: 'tool', tool_id: 'jira' }, kind: 'tool', label: 'Jira', visibility: 'only_me', ref: 'tool:jira' },
    ref: 'tool:jira', other_ref: 'tool:confluence', missing: 'Workspace citation ref is missing', again: { label: 'Atlassian Jira' }, key: 'tool:jira',
  },
  {
    name: 'tool container', since: 8, named: true, cited: { citation: container, kind: 'tool_container', label: 'Thermal', visibility: 'only_me' },
    again: { label: 'THERM', key: 'TH' }, key: 'tool_container:["jira","cloud-1","jira_project","10001"]',
  },
];
const RECORD_KINDS = ['imported_meeting', 'decision', 'action', 'rationale', 'note', 'document_passage'];
const isPrivate = (cited: Cited) => cited.visibility === 'only_me' || cited.visibility === 'approver_only';
/** One answered part whose one sentence cites every citation, private exactly when one of them is unless told otherwise. */
const response = (citations: readonly Cited[], private_ = citations.some(isPrivate)) => ({
  schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered', citations,
  parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'Launch moved to Tuesday.', citation_indexes: citations.map((_, index) => index), private: private_ }],
    blocks: [{ kind: 'answer', statements: [0] }] }],
});

describe.each(ROWS)('a $name citation', (row) => {
  it('is cited from its version: in an answer (8), on an impact card (6), in an evidence open (4)', () => {
    const accepted = validatePersonAnswerResponseV8(response([row.cited]));
    expect(accepted.citations).toEqual([row.cited]);
    expect(Object.isFrozen(accepted.citations[0])).toBe(true);
    expect(validatePersonAnswerCitationV8(row.cited)).toEqual(row.cited);
    // Stored impact cards and open items' live parts validate V6 citations.
    if (row.since <= 6) expect(validatePersonAnswerCitationV6(row.cited)).toEqual(row.cited);
    else expect(() => validatePersonAnswerCitationV6(row.cited)).toThrow('Ask response citation kind is invalid');
    // Evidence opens (a task's starting record, the live desk's open) stay V4.
    const open = { schema_version: 1, citation: row.cited.citation };
    if (row.since === 4) expect(validatePersonEvidenceOpenRequestV1(open).citation).toEqual(row.cited.citation);
    else expect(() => validatePersonEvidenceOpenRequestV1(open)).toThrow('Ask citation kind is invalid');
  });

  it('is named by its own kind, and a record or a passage by any record kind', () => {
    for (const kind of [...RECORD_KINDS, ...ROWS.filter(other => other.named).map(other => other.cited.kind)]) {
      const value = { ...row.cited, kind };
      if (kind === row.cited.kind || (!row.named && RECORD_KINDS.includes(kind))) expect(validatePersonAnswerCitationV8(value)).toEqual(value);
      else expect(() => validatePersonAnswerCitationV8(value)).toThrow(/^organization API: (Ticket|Page|Follow-up|Workspace) citation kind is inconsistent$/);
    }
    expect(() => validatePersonAnswerCitationV8({ ...row.cited, kind: 'team' })).toThrow('Ask response citation kind is invalid');
  });

  it('opens by the ref that names its item, and by no other', () => {
    if (row.ref !== undefined) expect(validatePersonAnswerCitationV8({ ...row.cited, ref: row.ref }).ref).toBe(row.ref);
    if (row.missing !== undefined) {
      const { ref: _ref, ...unopened } = row.cited;
      expect(() => validatePersonAnswerCitationV8(unopened)).toThrow(row.missing);
    } else expect(validatePersonAnswerCitationV8(row.cited)).not.toHaveProperty('ref');
    for (const ref of [...ROWS.map(other => other.ref), row.other_ref]) {
      if (ref !== undefined && ref !== row.ref) expect(() => validatePersonAnswerCitationV8({ ...row.cited, ref })).toThrow('Ask response citation ref is inconsistent');
    }
  });

  it('is cited once, by what it names and never by its label', () => {
    const again = { ...row.cited, ...row.again };
    expect(personAnswerCitationKeyV8(row.cited.citation as never)).toBe(row.key);
    expect(personAnswerCitationKeyV8(again.citation as never)).toBe(row.key);
    expect(() => validatePersonAnswerResponseV8(response([row.cited, again]))).toThrow('Ask response contains duplicate citations');
  });

  it('makes a sentence private exactly when it is', () => {
    for (const visibility of ['only_me', 'approver_only', 'team', 'project', 'projects']) {
      const value = { ...row.cited, visibility };
      expect(validatePersonAnswerResponseV8(response([value])).parts[0]!.statements[0]!.private).toBe(isPrivate(value));
      expect(() => validatePersonAnswerResponseV8(response([value], !isPrivate(value)))).toThrow('private is inconsistent');
    }
  });
});

describe('citations of every kind', () => {
  it('are cited together in one answer, on its own route', () => {
    expect(PERSON_ANSWER_PATH_V7).toBe('/v7/person/ask');
    const all = ROWS.map(row => row.cited);
    expect(validatePersonAnswerResponseV8(response(all)).citations).toEqual(all);
  });

  it('key a page by its section and version, and keep two tool containers apart wherever a colon falls', () => {
    expect(personAnswerCitationKeyV8(page as never)).not.toBe(personAnswerCitationKeyV8({ ...page, section_id: 's3' } as never));
    expect(personAnswerCitationKeyV8(page as never)).not.toBe(personAnswerCitationKeyV8({ ...page, version: '43' } as never));
    const cited = ROWS.find(row => row.name === 'tool container')!.cited;
    const left = { ...cited, citation: { ...container, external_scope_id: 'a:b', container_id: 'c' } };
    const right = { ...cited, citation: { ...container, external_scope_id: 'a', container_id: 'b:c' } };
    expect(validatePersonAnswerResponseV8(response([left, right])).citations).toHaveLength(2);
    expect(personAnswerCitationKeyV8(left.citation as never)).not.toBe(personAnswerCitationKeyV8(right.citation as never));
  });

  it('show a key only beside a tool container', () => {
    const [unkeyed, ...others] = ['tool container', 'project', 'tool', 'person', 'follow-up'].map(name => ROWS.find(row => row.name === name)!.cited);
    const keyed = { ...unkeyed!, key: 'THERM' };
    expect(validatePersonAnswerCitationV8(keyed)).toEqual(keyed);
    const space = { ...unkeyed!, citation: { ...container, tool_id: 'confluence', container: 'confluence_space', container_id: '123', permalink: 'https://acme.atlassian.net/wiki/spaces/THERM' }, label: 'Thermal space' };
    expect(validatePersonAnswerCitationV8(space)).toEqual(space);
    for (const value of others) expect(() => validatePersonAnswerCitationV8({ ...value!, key: 'THERM' })).toThrow('applies only to a tool container');
    for (const key of ['', ' THERM', 'THE\nRM', 'x'.repeat(257), 7]) expect(() => validatePersonAnswerCitationV8({ ...keyed, key })).toThrow();
    // An impact card's citation has no key at all.
    expect(() => validatePersonAnswerCitationV6({ ...ROWS[0]!.cited, key: 'THERM' })).toThrow('unexpected shape');
  });

  it('refuse a malformed ref', () => {
    const [meeting, project, tool] = ['approved record', 'project', 'tool'].map(name => ROWS.find(row => row.name === name)!.cited);
    // The retired transcript ref (ADR-0046) is no ref at all.
    for (const ref of [`record:${record}`, `meeting:${record} `, `meeting:sha256:${'A'.repeat(64)}`, 42, `transcript:${record}`]) {
      expect(() => validatePersonAnswerCitationV8({ ...meeting!, ref })).toThrow('Ask response citation ref is invalid');
    }
    for (const ref of [`project:${projectId} `, 'project:prj_1']) expect(() => validatePersonAnswerCitationV8({ ...project!, ref })).toThrow();
    for (const ref of ['tool:Jira', 'tool:']) expect(() => validatePersonAnswerCitationV8({ ...tool!, ref })).toThrow();
  });
});
