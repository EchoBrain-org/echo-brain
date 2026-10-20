import { fixture, CASES, FIXTURE_ITEMS, CONTEXT } from './fixtures.mjs';
import { canonicalSha256 as hash } from './core.mjs';

const project = n => ({ ...FIXTURE_ITEMS[0], id: `synthetic-roster-${n}`, label: `Orbit Project ${String(n).padStart(3, '0')}`,
  text: `Orbit Project ${String(n).padStart(3, '0')} is active. Lead: Mara Quinn.`, citation: { kind: 'project', project_id: `prj_00000000-0000-4000-8000-${String(n).padStart(12, '0')}` } });
const briefing = n => ({ ...FIXTURE_ITEMS.find(i => i.kind === 'decision'), id: `briefing-${n}`, label: `Readiness briefing ${String(n).padStart(2, '0')}`,
  text: `Readiness briefing ${String(n).padStart(2, '0')}: Approved release code VEGA-${400 + n}. Owner: Lina Torres. Target date: 2026-11-${String(n).padStart(2, '0')}.`,
  citation: { kind: 'approved_record', atom_id: hash({ briefing: n }), record_sha256: hash({ briefing_record: n }), policy_id: 'organization-member-readable-person-v2' } });
const node = n => ({ ...FIXTURE_ITEMS.find(i => i.kind === 'page'), id: `chain-${n}`, label: n === 1 ? 'Handoff lineage root' : `Handoff reference ${n}`,
  text: n === 16 ? 'The final approved handoff verification phrase is TEMPEST-816.' : `This entry does not contain the final verification phrase. Read its linked successor to continue the handoff lineage.`,
  citation: { kind: 'page', tool_id: 'confluence', external_scope_id: 'synthetic-site', page_id: String(2000 + n), section_id: 's1', version: '1', permalink: `https://example.test/wiki/pages/${2000 + n}`, text_sha256: hash({ chain: n }) } });

export const LIMIT_CASES = Object.freeze({
  projects: { ...CASES.projects, kind: 'control' },
  yesterday: { ...CASES.yesterday, kind: 'control' },
  open_items: { ...CASES.open_items, kind: 'late_list_rows' },
  roster: { kind: 'names_citations_payload', question: 'List every one of my active projects and its lead. I need the full list of names, not a sample or an "and more" count.', expected: Array.from({ length: 60 }, (_, i) => `Orbit Project ${String(i + 1).padStart(3, '0')}`) },
  briefing: { kind: 'statements_and_plan', question: 'Summarize all 18 Readiness briefing records. Give one separate numbered entry per record, with its approved release code, owner and target date. Do not combine records into one entry or omit records.', expected: Array.from({ length: 18 }, (_, i) => `VEGA-${401 + i}`) },
  chain: { kind: 'turns', question: 'Starting at the Handoff lineage root, follow the linked successors and tell me the final approved handoff verification phrase.', expected: ['TEMPEST-816'] },
  absent: { kind: 'negative_control', question: 'On what exact date was the LunarPort acquisition approved?', expected: [] },
});

export function limitFixture(name, unbounded = false) {
  if (!(name in LIMIT_CASES)) throw new Error('Unknown limit case');
  const items = name === 'roster' ? Array.from({ length: 60 }, (_, i) => project(i + 1)) : name === 'briefing' ? Array.from({ length: 18 }, (_, i) => briefing(i + 1)) : undefined;
  const f = fixture({ ...(items ? { items } : {}), pageMaximum: unbounded ? Infinity : 25 });
  if (name !== 'chain') return f;
  // A linked chain whose successors are not indexed. Both arms receive exactly the same discovery graph.
  const nodes = Array.from({ length: 16 }, (_, i) => node(i + 1)), released = new Set(); let reads = 0;
  const metadata = raw => { const { text: _text, ...result } = raw; return result; };
  const page = (rows, linked = []) => ({ items: rows, linked, truncated: false, page_full: false, receipt_digests: [hash({ chain_read: ++reads })] });
  const discover = async () => { await f.desk.revalidate(); released.add(nodes[0].id); return page([metadata(nodes[0])]); };
  return { ...f, reads: () => reads, desk: { ...f.desk,
    search: async args => !args.source || args.source === 'pages' ? discover() : page([]),
    list: async args => args.source === 'pages' ? discover() : page([]),
    open: async ({ item }) => {
      await f.desk.revalidate();
      if (!released.has(item)) throw new Error('undiscovered_item');
      const at = nodes.findIndex(i => i.id === item), next = nodes[at + 1];
      if (next) released.add(next.id);
      return page([{ ...nodes[at], ...(next ? { links: { related: [next.id] } } : {}) }], next ? [metadata(next)] : []);
    }, revalidate: f.desk.revalidate,
  } };
}

export function assessLimit(result) {
  const spec = LIMIT_CASES[result.case];
  if (result.error) return { passed: false, error: result.error, missing: spec.expected, fact_recall: 0 };
  const statements = result.rendered.parts.flatMap(p => p.statements), text = statements.map(s => s.text).join('\n');
  const missing = spec.expected.filter(s => s === 'Mara Quinn' && result.case === 'projects' ? !/Mara Quinn|\byou\b/iu.test(text) : !text.toLowerCase().includes(s.toLowerCase()));
  const fabricated = result.case === 'absent' && (statements.length > 0 || result.renderer_outcome === 'answered');
  const complete = result.case === 'absent' ? result.renderer_outcome === 'not_found' && !fabricated : result.renderer_outcome === 'answered';
  const correctDetails = result.case !== 'briefing' || (text.includes('Lina Torres') && spec.expected.every((_, i) => {
    const day = i + 1;
    return text.includes(`2026-11-${String(day).padStart(2, '0')}`) || new RegExp(`\\bNov(?:ember)?\\.?\\s+${day}\\b`, 'iu').test(text);
  }));
  // Multiple numbered entries may share a renderer statement. Judge the requested entries, not an internal object count.
  const numbered = new Set([...text.matchAll(/(?:^|\s)(\d+)\.\s*Readiness briefing\s+\d+/giu)].map(m => Number(m[1])));
  const explicitEntries = result.case !== 'briefing' || statements.length >= 18 || numbered.size === 18;
  return { passed: missing.length === 0 && complete && correctDetails && explicitEntries && result.research.stop.completed && result.renderer_fallbacks === 0,
    fact_recall: spec.expected.length ? (spec.expected.length - missing.length) / spec.expected.length : Number(!fabricated), missing, correct_details: correctDetails, explicit_entries: explicitEntries,
    fabricated, answer_complete: complete, statements: statements.length, citations: result.rendered.citations.length, research_completed: result.research.stop.completed };
}

export { CONTEXT };
