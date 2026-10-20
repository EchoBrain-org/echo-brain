import { canonicalSha256, createAgenticListEvidenceV1, agenticListEndUnverifiedV1, describeAgenticEvidenceItemV1, fillAgenticTaskV1, parseStep } from './core.mjs';

/** Experiment-only adapter. Its public constructor refuses anything but the bundled synthetic fixture. */
export function createBridge(fixture, brief, { signal = new AbortController().signal, onEvent = () => {}, unbounded = false, parsePlan = parseStep } = {}) {
  if (fixture.synthetic !== true) throw new Error('Only synthetic fixtures are supported; live access fencing is not qualified.');
  const { desk, sources, context } = fixture;
  const items = new Map(), byShort = new Map(), lists = new Map(), receipts = new Set(), unreadable = [];
  const rounds = [], reads = [];
  let goal = brief.goal, terminal, serial = Promise.resolve(), checkedAt = null, deskMs = 0;
  const started = performance.now();
  const deadline = unbounded ? Infinity : started + brief.budget.deadline_ms - brief.budget.writer_reserve_ms - 1000;
  const assertLive = () => { signal.throwIfAborted(); if (terminal) throw terminal; if (performance.now() >= deadline) throw new Error('research_deadline'); };
  async function check() { assertLive(); checkedAt = (await desk.revalidate({ signal, mode: 'incremental' })).checked_at; }
  function register(raw, opened = false, preloaded = false) {
    let entry = items.get(raw.id);
    if (!entry) {
      entry = { short: `E${items.size + 1}`, source: sources.find(s => s.source_id === raw.source_id)?.selector ?? raw.source_id, item: raw, full: false, opened: false, preloaded: false, touched: rounds.length, cited_by_plan: false };
      items.set(raw.id, entry); byShort.set(entry.short, entry);
    }
    entry.item = raw.text === undefined && entry.item.text !== undefined ? entry.item : raw;
    entry.full ||= raw.text !== undefined;
    entry.opened ||= opened; entry.preloaded ||= preloaded;
    receipts.add(raw.receipt_sha256);
    return entry;
  }
  function visible(entry) {
    return { ...describeAgenticEvidenceItemV1(entry, context.time_zone), ...(entry.full ? { text: entry.item.text } : {}),
      ...(entry.item.links ? { links: Object.fromEntries(Object.entries(entry.item.links).map(([name, ids]) => [name, ids.flatMap(id => items.has(id) ? [items.get(id).short] : [])])) } : {}) };
  }
  async function ingest(operation, input, { preloaded = false } = {}) {
    await check();
    const began = performance.now();
    const result = await desk[operation]({ ...input, signal });
    deskMs += performance.now() - began;
    // No result is exposed after revocation, even if the read itself succeeded.
    await check();
    for (const receipt of result.receipt_digests) receipts.add(receipt);
    const entries = result.items.map(i => register(i, operation === 'open' || preloaded, preloaded));
    const linked = (result.linked ?? []).map(i => register(i));
    reads.push({ tool: operation, source: input.source ?? entries[0]?.source ?? 'all', returned_items: entries.length, truncated: result.truncated, notice: Boolean(result.notice), unavailable: false });
    return { result, entries, linked };
  }
  async function execute(tool, args) {
    assertLive();
    let source, input, listKey, state;
    if (!['search', 'list', 'open'].includes(tool)) throw new Error('unknown_tool');
    if (tool === 'list' && brief.options.list === false) throw new Error('list_disabled_for_trigger');
    if (tool === 'open') {
      const entry = byShort.get(args.id);
      if (!entry) throw new Error('Open only an E id returned by this request.');
      input = { item: entry.item.id };
    } else {
      source = sources.find(s => s.selector === args.source);
      if (!source && (tool === 'list' || args.source)) throw new Error('Source is not available in this request.');
      const capabilities = source?.capabilities;
      for (const field of ['kind', 'status', 'owner', 'role']) if (args[field] !== undefined) {
        const allowed = capabilities?.filters?.[field];
        if (!allowed || (Array.isArray(allowed) && !allowed.includes(args[field]))) throw new Error(`Unsupported ${field} filter. Available capabilities: ${JSON.stringify(capabilities)}`);
      }
      if (args.date_field && args.date_field !== 'any' && !capabilities?.dates?.[args.date_field]) throw new Error('Unsupported date_field. Consult source_catalog.');
      input = { ...(source ? { source: source.source_id } : {}), ...(args.query ? { query: args.query } : {}), limit: args.limit ?? (unbounded ? Number.MAX_SAFE_INTEGER : 25), time_zone: context.time_zone };
      if (args.kind) input.kinds = [args.kind];
      for (const key of ['status', 'owner', 'role', 'since', 'until', 'date_field']) if (args[key] !== undefined) input[key] = args[key];
      if (tool === 'list') {
        listKey = JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'limit').sort()));
        state = lists.get(listKey);
        if (state?.record.ended) { await check(); return { list: state.record, items: [], more: false, note: 'This list has already reached its end.' }; }
        if (state?.cursor) input.cursor = state.cursor;
      }
    }
    const { result, entries, linked } = await ingest(tool, input);
    let list;
    if (tool === 'list') {
      const filter = { time_zone: context.time_zone }, applied = {};
      for (const field of ['kind', 'status', 'owner', 'role', 'since', 'until', 'date_field']) if (args[field] !== undefined) { filter[field] = args[field]; applied[field] = 'applied'; }
      const members = [...new Set([...(state?.record.members ?? []), ...entries.map(e => e.short)])];
      list = createAgenticListEvidenceV1({ id: state?.record.id ?? `L${lists.size + 1}`, source: source.selector, filter, filter_applied: applied, members, shown: members.length,
        ended: !result.next_cursor, unverified_end: agenticListEndUnverifiedV1({ returned: result.items.length, requested: input.limit, next_cursor: result.next_cursor, page_full: result.page_full }),
        available: (state?.record.available ?? true) && !result.notice, truncated: (state?.record.truncated ?? false) || result.truncated, read_at: state?.record.read_at ?? context.now,
        ...(result.unchecked ? { unchecked: result.unchecked } : {}) });
      lists.set(listKey, { record: list, cursor: result.next_cursor });
    }
    const action = { tool, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])), result: { items: entries.map(e => e.short), opened: entries.filter(e => e.full).map(e => e.short), ...(tool === 'open' ? { id: args.id } : {}), more: Boolean(result.next_cursor), truncated: result.truncated, notice: Boolean(result.notice) } };
    rounds.push({ round: rounds.length + 1, elapsed_ms: performance.now() - started, plan: [], actions: [action], rejected: [] });
    onEvent({ tool, source: source?.selector ?? entries[0]?.source, count: entries.length, more: Boolean(result.next_cursor) });
    return { items: entries.map(visible), linked: linked.map(visible), ...(list ? { list } : {}), more: Boolean(result.next_cursor), truncated: result.truncated, ...(result.notice ? { notice: result.notice } : {}), ...(result.unchecked ? { unchecked: result.unchecked } : {}) };
  }
  return {
    async initialize() {
      const ids = [];
      for (const start of brief.starting) {
        try { const { entries } = await ingest('openCitation', { citation: start.citation }, { preloaded: true }); ids.push(entries[0]?.short ?? null); }
        catch (error) {
          // Only a confirmed unavailable starting item may be reported. Revocation stays terminal.
          if (start.if_unreadable !== 'report' || error.message !== 'unreadable_starting') throw error;
          unreadable.push(start.citation); ids.push(null);
        }
      }
      if (goal.kind === 'task') goal = { kind: 'task', task: fillAgenticTaskV1(goal.task, ids, goal.data ?? []) };
      await check();
      return { goal, source_catalog: fixture.catalog.entries, context, scope: desk.scope, starting: [...items.values()].map(visible) };
    },
    call(tool, args) {
      const run = serial.then(() => execute(tool, args));
      serial = run.catch(error => { if (['access_revoked', 'research_deadline'].includes(error.message) || signal.aborted) terminal = error; });
      return run;
    },
    async bundle(output, metrics = {}) {
      await serial; await check(); await desk.revalidate({ signal, mode: 'full' });
      const parts = parsePlan({ parts: output.parts, actions: [] }, { lists: true }).parts;
      const plan = parts.map((part, index) => ({ ...part, part: index + 1, needs: part.needs.map(need => {
        if (goal.kind !== 'task') return need;
        const { kind: _kind, ...taskNeed } = need; return taskNeed;
      }) }));
      const listById = new Map([...lists.values()].map(s => [s.record.id, s.record]));
      for (const part of plan) for (const need of part.needs) {
        for (const id of need.evidence) {
          const entry = byShort.get(id), list = listById.get(id);
          if (!entry && !list) throw new Error(`Unknown evidence ${id}`);
          // Match the real research loop: only released full text can enter the writer's text-evidence priority queue.
          // A cited metadata row remains list evidence; it must never become a body with undefined text.
          if (entry?.full) entry.cited_by_plan = true;
        }
        if (need.status === 'found') {
          if (!need.evidence.length) throw new Error('Found need requires evidence.');
          if (need.kind === 'which_items' && !need.evidence.some(id => listById.get(id)?.complete)) throw new Error('Complete enumeration requires a complete list.');
          if ((need.kind ?? 'content') === 'content' && !need.evidence.some(id => byShort.get(id)?.full)) throw new Error('Content need requires released text.');
          if (need.kind === 'which_say') {
            const selected = need.evidence.map(id => listById.get(id)).filter(Boolean);
            if (!selected.length || selected.some(l => !l.complete || l.members.some(id => !byShort.get(id)?.full))) throw new Error('which_say requires complete lists and every member read.');
          }
        }
      }
      const completed = output.completed === true && plan.every(p => p.needs.every(n => n.status !== 'open'));
      return { schema_version: 1, kind: 'echo-agentic-evidence-bundle-v1', trigger: 'synthetic_headless_trial', goal, budget: brief.budget, plan,
        items: [...items.values()], ...(goal.kind === 'question' ? { lists: [...listById.values()] } : {}), unreadable_starting: unreadable, rounds,
        coverage: { reads, inventories: [], notices: completed ? [] : ['Synthetic research did not finish.'] }, stop: { reason: completed ? 'finished' : 'budget', completed },
        cost: { rounds: metrics.turns ?? 0, model_calls: metrics.model_calls ?? 0, repairs: 0, fallbacks: 0, input_tokens: metrics.input_tokens ?? null, output_tokens: metrics.output_tokens ?? null, total_tokens: metrics.total_tokens ?? null, model_ms: metrics.model_ms ?? 0, desk_ms: deskMs, elapsed_ms: performance.now() - started },
        gathered_for: { scope: desk.scope, checked_at: checkedAt }, server: { receipts: [...receipts], invocation_digests: [canonicalSha256({ synthetic_output: output })], generations: [] } };
    },
    check,
  };
}
