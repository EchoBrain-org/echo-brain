import { canonicalSha256 as hash, PROJECTS_SOURCE_DESCRIPTOR_V1, PEOPLE_SOURCE_DESCRIPTOR_V1, TOOLS_SOURCE_DESCRIPTOR_V1, MEETINGS_SOURCE_CAPABILITIES_V1, DOCUMENTS_SOURCE_CAPABILITIES_V1, matchesEvidenceDateV1 } from './core.mjs';

export const CONTEXT = Object.freeze({ asked_by: 'Mara Quinn', today: '2026-10-20', now: '2026-10-20T18:00:00.000Z', time_zone: 'America/Los_Angeles', time_reference: 'client' });
const projectId = n => `prj_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caps = (filters, dates = { created: 'When created', updated: 'When updated' }) => ({ filters, dates, any_date: true, links: [] });
export const SOURCES = Object.freeze([
  { source_id: 'meeting', selector: 'meetings', kinds: ['decision', 'action'], description: 'Approved meeting decisions and actions.', capabilities: MEETINGS_SOURCE_CAPABILITIES_V1 },
  { source_id: 'document', selector: 'documents', kinds: ['note', 'document_passage'], description: 'ECHO notes and uploaded document passages.', capabilities: DOCUMENTS_SOURCE_CAPABILITIES_V1 },
  ...[PROJECTS_SOURCE_DESCRIPTOR_V1, PEOPLE_SOURCE_DESCRIPTOR_V1, TOOLS_SOURCE_DESCRIPTOR_V1].map(s => ({ ...s, kinds: [s.kind] })),
  { source_id: 'tickets', selector: 'tickets', kind: 'ticket', kinds: ['ticket'], tool_id: 'jira', metadata_only_list: true, description: 'Current Jira issues. Lists show metadata; open an item for its body. No status or owner filtering is available.', capabilities: caps({}) },
  { source_id: 'pages', selector: 'pages', kind: 'page', kinds: ['page'], tool_id: 'confluence', metadata_only_list: true, description: 'Confluence page metadata. Open for page body.', capabilities: caps({}) },
]);
export function catalog(sources) {
  const by_id = new Map(sources.map(s => [s.source_id, s]));
  return { entries: sources.map(({ source_id, selector, kinds, ...s }) => ({ ...s, source: selector })), by_id, resolve: value => sources.find(s => s.selector === value || s.source_id === value)?.source_id };
}
function item(source, id, label, text, kind, citation, attributes = {}, dates = {}) {
  return { id: `private_desk_${id}`, source_id: source, kind, citation, label, text, attributes, dates, visibility: 'only_me', receipt_sha256: hash({ id, text }), project: id.startsWith('b-') ? 'beta' : 'alpha' };
}
const record = (id, label, text, kind = 'decision', attributes = {}, dates = {}) => item('meeting', id, label, text, kind, { kind: 'approved_record', atom_id: hash({ id }), record_sha256: hash({ record: id }), policy_id: 'organization-member-readable-person-v2' }, attributes, dates);
const project = (id, name, lead) => item('projects', id, name, `${name} is active. Lead: ${lead}. Members: Mara Quinn and Tobias Lund.`, 'project', { kind: 'project', project_id: projectId(id === 'alpha' ? 1 : 2) }, { status: 'active', role: id === 'alpha' ? 'lead' : 'member', leads: lead }, { created: '2026-10-01T12:00:00Z' });
const ticket = n => item('tickets', `ticket-${n}`, `DEMO-${n}: ${n % 17 === 0 ? 'Calibration follow-up' : 'Fixture work'}`, `DEMO-${n}: ${n % 17 === 0 ? 'Calibration review remains open.' : 'Work completed.'}`, 'ticket', { kind: 'ticket', tool_id: 'jira', external_scope_id: 'synthetic-site', ticket_id: String(n), permalink: `https://example.test/browse/DEMO-${n}`, text_sha256: hash({ body: n }) }, { status: n % 17 === 0 ? 'Open' : 'Done', owner: n % 2 ? 'Mara Quinn' : 'Tobias Lund' }, { created: '2026-10-01T12:00:00Z', updated: n === 17 ? '2026-10-20T01:30:00Z' : '2026-10-17T12:00:00Z' });
export const FIXTURE_ITEMS = Object.freeze([
  project('alpha', 'Atlas', 'Mara Quinn'), project('b-beta', 'Beacon', 'Tobias Lund'),
  record('decision', 'Synthetic release review', 'The team approved calibration on every unit before shipment.', 'decision', {}, { occurred: '2026-10-20T01:00:00Z' }),
  record('action', 'Synthetic release review action', 'Mara Quinn will publish the calibration checklist.', 'action', { owner: 'Mara Quinn', status: 'open' }, { occurred: '2026-10-20T01:00:00Z' }),
  record('old-decision', 'Synthetic old review', 'The old review approved a packaging mockup.', 'decision', {}, { occurred: '2026-10-18T12:00:00Z' }),
  item('pages', 'page', 'Calibration verification plan', 'The verification plan now requires one calibration record for each shipped unit.', 'page', { kind: 'page', tool_id: 'confluence', external_scope_id: 'synthetic-site', page_id: '1234', section_id: 's1', version: '2', permalink: 'https://example.test/wiki/pages/1234', text_sha256: hash({ page: 1234 }) }, {}, { created: '2026-10-04T12:00:00Z', updated: '2026-10-20T02:00:00Z' }),
  ...Array.from({ length: 105 }, (_, n) => ticket(n + 1)),
]);

/** Synthetic permission fixture only; deliberately cannot accept a live desk or credentials. */
export function fixture({ scope = 'global', connected = true, revokeAfter = Infinity } = {}) {
  let reads = 0; let revoked = false;
  const sources = SOURCES.filter(s => scope === 'mine' ? ['meeting', 'document'].includes(s.source_id) : connected || !['tickets', 'pages'].includes(s.source_id));
  const allowed = FIXTURE_ITEMS.filter(i => sources.some(s => s.source_id === i.source_id) && (scope !== 'project' || i.project === 'alpha'));
  const released = new Set();
  const check = () => { if (revoked || reads >= revokeAfter) throw new Error('access_revoked'); };
  const deskScope = scope === 'project' ? { kind: 'project', project_id: projectId(1) } : { kind: scope };
  const read = (input, search = false) => {
    check(); reads++;
    if (input.source !== undefined && !sources.some(s => s.source_id === input.source)) throw new Error('source_unavailable');
    let rows = allowed.filter(i => input.source === undefined || i.source_id === input.source);
    if (input.kinds) rows = rows.filter(i => input.kinds.includes(i.kind));
    for (const field of ['status', 'owner', 'role']) if (input[field]) rows = rows.filter(i => String(i.attributes[field] ?? '').toLowerCase().includes(input[field].toLowerCase()));
    if (input.since || input.until) rows = rows.filter(i => matchesEvidenceDateV1(i.dates, input, i.source_id === 'meeting' ? 'occurred' : 'created'));
    if (search && input.query) {
      const terms = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
      rows = rows.filter(i => terms.some(t => `${i.label} ${i.text}`.toLowerCase().includes(t)));
    }
    const offset = input.cursor ? Number(input.cursor) : 0;
    const limit = Math.min(input.limit ?? 25, 25);
    const page = rows.slice(offset, offset + limit).map(({ project: _project, ...i }) => {
      released.add(i.id);
      if (['ticket', 'page'].includes(i.kind) || (!search && i.source_id === 'meeting')) { const { text: _text, ...metadata } = i; return metadata; }
      return i;
    });
    return { items: page, truncated: search && rows.length > limit, receipt_digests: [hash({ reads })], page_full: false, ...(!search && rows.length > offset + limit ? { next_cursor: String(offset + limit) } : {}) };
  };
  const desk = {
    scope: deskScope, live_sources: sources.filter(s => !['meeting', 'document'].includes(s.source_id)),
    search: async input => read(input, true), list: async input => read(input),
    open: async ({ item: id }) => {
      check(); reads++;
      if (!released.has(id)) throw new Error('undiscovered_item');
      const row = allowed.find(i => i.id === id); if (!row) throw new Error('access_denied');
      const { project: _project, ...visible } = row;
      return { items: [visible], truncated: false, receipt_digests: [hash({ reads })] };
    },
    openCitation: async ({ citation }) => {
      check(); const row = allowed.find(i => hash(i.citation) === hash(citation));
      if (!row) throw new Error('unreadable_starting'); released.add(row.id); return desk.open({ item: row.id });
    },
    revalidate: async () => { check(); return { checked_at: CONTEXT.now }; },
  };
  return { synthetic: true, desk, sources, catalog: catalog(sources), context: CONTEXT, revoke: () => { revoked = true; }, reads: () => reads };
}

export const CASES = Object.freeze({
  projects: { question: 'What are my active projects, and who leads each one?', expected: ['Atlas', 'Mara Quinn', 'Beacon', 'Tobias Lund'] },
  yesterday: { question: 'What happened yesterday? Include meeting decisions, actions, Jira updates and Confluence changes.', expected: ['calibration', 'DEMO-17', 'verification'] },
  open_items: { question: 'What are the open items, and who owns them? Include meeting actions and Jira issues.', expected: ['checklist', ...[17, 34, 51, 68, 85, 102].map(n => `DEMO-${n}`)] },
});
