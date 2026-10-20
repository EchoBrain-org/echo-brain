import { createHash } from 'node:crypto';

export const STAGING_ORIGIN = 'https://authority-staging.echobrain.org';
const stamp = value => JSON.stringify([value.authority_origin, value.authority_id, value.organization_id, value.principal_id, value.membership_id]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Public Person reads only. This is not the server's full research desk and fabricates no Authority receipts. */
export function stagingReader(client, { signal, onEvent = () => {} } = {}) {
  const identity = client.sessionSummary(), identityStamp = stamp(identity);
  if (identity.authority_origin !== STAGING_ORIGIN) throw new Error('staging_only');
  const witnesses = new Map(), evidence = new Map(), refs = new Map();
  let serial = Promise.resolve(), failed = false, checks = 0, reads = 0;
  const current = () => { signal?.throwIfAborted(); if (failed || stamp(client.sessionSummary()) !== identityStamp) throw new Error('staging_identity_changed'); };
  async function invoke(run) { current(); const result = await run(); current(); reads++; return result; }
  async function pages(method, args) {
    const items = [], seen = new Set(); let cursor;
    do {
      const page = await invoke(() => client[method]({ ...args, ...(cursor ? { cursor } : {}) }, signal));
      if (page.notice) throw new Error('staging_read_incomplete');
      items.push(...page.items); cursor = page.next_cursor;
      if (cursor && seen.has(cursor)) throw new Error('staging_cursor_repeated');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function record(ref) {
    const result = [], seen = new Set(); let cursor;
    do {
      const page = await invoke(() => client.open({ schema_version: 1, ref, ...(cursor ? { cursor } : {}) }, signal));
      const { next_cursor, ...content } = page; result.push(content); cursor = next_cursor;
      if (cursor && seen.has(cursor)) throw new Error('staging_cursor_repeated');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }
  async function witnessed(key, run) {
    const result = await run(), hash = digest(result), previous = witnesses.get(key);
    if (previous && previous.hash !== hash) throw new Error('staging_snapshot_changed');
    witnesses.set(key, { hash, run }); return result;
  }
  function release(ref, kind, content) {
    let id = refs.get(ref);
    if (!id) { id = `S${evidence.size + 1}`; refs.set(ref, id); }
    if (kind === 'record_metadata' && evidence.get(id)?.kind === 'record_body') return evidence.get(id);
    evidence.set(id, { id, ref, kind, content }); return evidence.get(id);
  }
  const queue = run => {
    const work = serial.then(async () => {
      try { current(); return await run(); }
      catch (error) { if (error.message === 'staging_identity_changed' || signal?.aborted) failed = true; throw error; }
    });
    serial = work.catch(() => {}); return work;
  };
  async function revalidate() {
    current(); await invoke(() => client.changes(signal));
    for (const { hash, run } of witnesses.values()) if (digest(await run()) !== hash) throw new Error('staging_snapshot_changed');
    current(); checks++; onEvent({ event: 'access_checked', checks, witnesses: witnesses.size });
  }
  return {
    context: { name: identity.display_name, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toISOString(), origin: STAGING_ORIGIN,
      available: ['ECHO projects and members', 'ECHO meeting records, notes and documents'], unavailable: ['Live Jira search/list', 'Live Confluence search/list', 'Server follow-up research source'] },
    async check() { return queue(async () => { try { await revalidate(); } catch { failed = true; throw new Error('staging_access_stopped'); } }); },
    async call(name, args) {
      return queue(async () => {
        try {
          await revalidate(); let result;
          if (name === 'list_projects') {
            const status = args.status ?? 'active'; if (!['active', 'archived'].includes(status)) throw new Error('invalid_status');
            const rows = await witnessed(`projects:${status}`, () => pages('projectsV2', { status }));
            result = { complete: true, items: rows.map(row => release(`project:${row.project_id}`, 'project', row)) };
          } else if (name === 'list_records') {
            const mine = args.mine === true;
            const rows = await witnessed(`records:${mine}`, () => pages('list', { schema_version: 1, ...(mine ? { mine: true } : {}) }));
            result = { complete: true, items: rows.map(row => release(row.ref, 'record_metadata', row)) };
          } else if (name === 'open_record') {
            const entry = evidence.get(args.id);
            if (!entry || !['record_metadata', 'record_body'].includes(entry.kind)) throw new Error('unknown_record');
            const content = await witnessed(`open:${entry.ref}`, () => record(entry.ref));
            result = release(entry.ref, 'record_body', content);
          } else if (name === 'project_members') {
            const entry = evidence.get(args.id);
            if (!entry || entry.kind !== 'project') throw new Error('unknown_project');
            const rows = await witnessed(`members:${entry.ref}`, () => pages('projectMembers', { project_id: entry.content.project_id }));
            result = release(`members:${entry.content.project_id}`, 'project_members', { project: entry.content.name, complete: true, items: rows });
          } else throw new Error('unknown_tool');
          await revalidate(); onEvent({ event: 'person_read', tool: name, evidence_items: evidence.size }); return result;
        } catch (error) {
          if (!['unknown_record', 'unknown_project', 'unknown_tool', 'invalid_status'].includes(error.message)) failed = true;
          throw error;
        }
      });
    },
    validateAnswer(answer) {
      current();
      if (!answer || !['answered', 'partial', 'not_found'].includes(answer.status) || !Array.isArray(answer.statements) || !Array.isArray(answer.missing)) throw new Error('invalid_answer');
      for (const statement of answer.statements) if (typeof statement.text !== 'string' || !statement.text.trim() || !Array.isArray(statement.evidence) || !statement.evidence.length || statement.evidence.some(id => !evidence.has(id))) throw new Error('invalid_citation');
      if ((answer.status === 'answered' && (!answer.statements.length || answer.missing.length)) || (answer.status === 'not_found' && answer.statements.length)) throw new Error('invalid_outcome');
      return { ...answer, citations: [...new Set(answer.statements.flatMap(s => s.evidence))].map(id => evidence.get(id)) };
    },
    stats: () => ({ checks, reads, witnesses: witnesses.size, evidence_items: evidence.size, stopped: failed }),
  };
}
