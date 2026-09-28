import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENTIC_ASK_MAX_MODEL_CALLS_V1,
  createAgenticAskV1,
  type AgenticAskAuditEntryV1,
} from '../../src/answer-composition/agentic-ask-v1.js';
import type { StructuredGenerationInput, StructuredGenerationPort } from '../../src/answer-composition/retrieval-grounded-answer-composition.js';
import type { EvidenceDeskItemV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from '../../src/shared/evidence-desk-v1.js';

const generation = {
  generation_adapter_id: 'test-adapter',
  planner_model: 'test-planner',
  answer_model: 'test-answer',
  timeout_ms: 5_000,
};

function item(id: string, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  const atom = canonicalSha256({ id });
  const record = canonicalSha256({ id, kind: 'record' });
  return {
    id,
    citation: {
      kind: 'approved_record',
      atom_id: atom,
      record_sha256: record,
      policy_id: 'organization-member-readable-person-v2',
    },
    kind: 'decision',
    text: `released body for ${id}`,
    label: `Label ${id}`,
    visibility: 'team',
    receipt_sha256: canonicalSha256({ id }),
    ...options,
  };
}

type TestDeskResult = Omit<EvidenceDeskResultV1, 'receipt_digests'> & Partial<Pick<EvidenceDeskResultV1, 'receipt_digests'>>;

function desk(options: {
  readonly search?: (query: string | undefined) => TestDeskResult;
  readonly revalidate?: () => Promise<{ readonly checked_at: string }>;
} = {}): EvidenceDeskPortV1 {
  return {
    scope: { kind: 'global' },
    search: async input => {
      const result = options.search?.(input.query) ?? { items: [], truncated: false };
      return { ...result, receipt_digests: result.receipt_digests ?? [] };
    },
    open: async () => ({ items: [], truncated: false, receipt_digests: [] }),
    revalidate: async () => options.revalidate?.() ?? { checked_at: '2026-09-27T00:00:00.000Z' },
  };
}

function role(input: StructuredGenerationInput): 'plan' | 'judge' | 'writer' | 'summary' {
  if (input.system_prompt.includes('Split only')) return 'plan';
  if (input.system_prompt.includes('Mark each')) return 'judge';
  if (input.system_prompt.includes('Write only')) return 'writer';
  return 'summary';
}

function plan(parts: readonly { readonly question: string; readonly queries?: readonly string[] }[]) {
  return { parts: parts.map(part => ({ question: part.question, queries: part.queries ?? [] })) };
}

function judged(parts: readonly { readonly id: string; readonly status: 'answered' | 'partial' | 'missing'; readonly evidence_ids: readonly string[]; readonly new_queries?: readonly string[] }[], done = true) {
  return {
    scope: { matches_question: true, note: '' },
    parts: parts.map(part => ({ id: part.id, status: part.status, evidence_ids: part.evidence_ids, new_queries: part.new_queries ?? [] })),
    done,
  };
}

function composition(model: StructuredGenerationPort, evidenceDesk: EvidenceDeskPortV1, entries: AgenticAskAuditEntryV1[] = [], append: (entry: AgenticAskAuditEntryV1) => unknown = entry => entries.push(entry)) {
  return createAgenticAskV1({ desk: evidenceDesk, model, generation, audit: { append } });
}

describe('Agentic Ask V1 adversarial boundaries', () => {
  it('treats a revalidation failure as terminal and never repairs or falls back around it', async () => {
    const model: StructuredGenerationPort = { generate: vi.fn(async () => plan([{ question: 'Question' }])) };
    const entries: AgenticAskAuditEntryV1[] = [];
    const answer = composition(model, desk({ revalidate: async () => { throw new Error('membership revoked'); } }), entries);

    await expect(answer.answer({ question: 'Question' })).rejects.toThrow('membership revoked');
    expect(model.generate).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it('does not admit a queued parallel writer after another writer revalidation fails', async () => {
    let revalidations = 0;
    const authorizationFailure = new Error('membership revoked during writer admission');
    const calls: string[] = [];
    const model: StructuredGenerationPort = {
      generate: vi.fn(async input => {
        const current = role(input); calls.push(current);
        switch (current) {
          case 'plan': return plan([{ question: 'First', queries: ['first'] }, { question: 'Second', queries: ['second'] }]);
          case 'judge': return judged([{ id: 'p1', status: 'answered', evidence_ids: ['one'] }, { id: 'p2', status: 'answered', evidence_ids: ['two'] }]);
          case 'writer': throw new Error('a writer must not start after an admission fence failure');
          case 'summary': return { statement: null };
        }
      }),
    };
    const entries: AgenticAskAuditEntryV1[] = [];
    const answer = composition(model, desk({
      search: query => query === 'first' ? { items: [item('one')], truncated: false } : query === 'second' ? { items: [item('two')], truncated: false } : { items: [], truncated: false },
      revalidate: async () => {
        revalidations += 1;
        if (revalidations === 3) throw authorizationFailure; // plan, judge, then first writer
        return { checked_at: '2026-09-27T00:00:00.000Z' };
      },
    }), entries);

    await expect(answer.answer({ question: 'Both' })).rejects.toBe(authorizationFailure);
    expect(calls).toEqual(['plan', 'judge']);
    expect(revalidations).toBe(3);
    expect(entries).toEqual([]);
  });

  it('cancels during generation and while the terminal audit is being written', async () => {
    const duringModel = new AbortController();
    const model: StructuredGenerationPort = {
      generate: vi.fn(async () => {
        duringModel.abort();
        throw new DOMException('cancelled by caller', 'AbortError');
      }),
    };
    const entries: AgenticAskAuditEntryV1[] = [];
    await expect(composition(model, desk(), entries).answer({ question: 'Question', signal: duringModel.signal })).rejects.toThrow(/cancel/i);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('cancelled');

    const duringAudit = new AbortController();
    const complete: StructuredGenerationPort = {
      generate: async input => {
        switch (role(input)) {
          case 'plan': return plan([{ question: 'Question' }]);
          case 'judge': return judged([{ id: 'p1', status: 'answered', evidence_ids: ['e1'] }]);
          case 'writer': return { statements: [{ text: 'Supported.', evidence_ids: ['e1'] }] };
          case 'summary': return { statement: null };
        }
      },
    };
    const auditEntries: AgenticAskAuditEntryV1[] = [];
    const answer = composition(complete, desk({ search: () => ({ items: [item('e1')], truncated: false }) }), auditEntries, entry => {
      auditEntries.push(entry);
      duringAudit.abort();
    });
    await expect(answer.answer({ question: 'Question', signal: duringAudit.signal })).rejects.toThrow(/cancel/i);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.outcome).toBe('answered');
  });

  it('admits new round-two evidence after eight initial results and supplies it to the assigned writer', async () => {
    const initial = Array.from({ length: 8 }, (_, index) => item(`initial-${index}`));
    const next = item('round-two');
    let judgeCalls = 0;
    const writerInputs: unknown[] = [];
    const model: StructuredGenerationPort = {
      generate: async input => {
        switch (role(input)) {
          case 'plan': return plan([{ question: 'Question', queries: ['first'] }]);
          case 'judge':
            judgeCalls += 1;
            return judgeCalls === 1
              ? judged([{ id: 'p1', status: 'partial', evidence_ids: ['initial-0'], new_queries: ['second'] }], false)
              : judged([{ id: 'p1', status: 'answered', evidence_ids: ['round-two'] }]);
          case 'writer': writerInputs.push(JSON.parse(input.user_prompt)); return { statements: [{ text: 'Second round matters.', evidence_ids: ['round-two'] }] };
          case 'summary': return { statement: null };
        }
      },
    };
    const answer = composition(model, desk({
      search: query => query === 'Question' ? { items: initial, truncated: false } : query === 'second' ? { items: [next], truncated: false } : { items: [], truncated: false },
    }));
    const result = await answer.answer({ question: 'Question' });
    expect(result.parts[0]?.statements[0]?.text).toBe('Second round matters.');
    expect((writerInputs[0] as { evidence: readonly { id: string }[] }).evidence.map(value => value.id)).toEqual(['round-two', ...initial.map(value => value.id)]);
  });

  it('gives each writer only the evidence the judge assigned to its part', async () => {
    const writerInputs: Record<string, readonly string[]> = {};
    const model: StructuredGenerationPort = {
      generate: async input => {
        switch (role(input)) {
          case 'plan': return plan([{ question: 'First', queries: ['first'] }, { question: 'Second', queries: ['second'] }]);
          case 'judge': return judged([{ id: 'p1', status: 'answered', evidence_ids: ['a'] }, { id: 'p2', status: 'answered', evidence_ids: ['b'] }]);
          case 'writer': {
            const user = JSON.parse(input.user_prompt) as { question: string; evidence: readonly { id: string }[] };
            writerInputs[user.question] = user.evidence.map(value => value.id);
            return { statements: [{ text: `${user.question} supported.`, evidence_ids: user.evidence.map(value => value.id) }] };
          }
          case 'summary': return { statement: null };
        }
      },
    };
    await composition(model, desk({ search: query => query === 'first' ? { items: [item('a')], truncated: false } : query === 'second' ? { items: [item('b')], truncated: false } : { items: [], truncated: false } })).answer({ question: 'Both' });
    expect(writerInputs).toEqual({ First: ['a'], Second: ['b'] });
  });

  it('drops unknown writer and summary citations while keeping known released evidence', async () => {
    const model: StructuredGenerationPort = {
      generate: async input => {
        switch (role(input)) {
          case 'plan': return plan([{ question: 'Question' }]);
          case 'judge': return judged([{ id: 'p1', status: 'answered', evidence_ids: ['known'] }]);
          case 'writer': return { statements: [{ text: 'Known support.', evidence_ids: ['known', 'forged'] }] };
          case 'summary': return { statement: { text: 'Forged only.', evidence_ids: ['forged'] } };
        }
      },
    };
    const result = await composition(model, desk({ search: () => ({ items: [item('known')], truncated: false }) })).answer({ question: 'Question' });
    expect(result.citations).toHaveLength(1);
    expect(result.parts[0]?.statements[0]?.citation_indexes).toEqual([0]);
    expect(result.direct).toBeUndefined();
  });

  it('continues when a judge incorrectly says done with a partial part, and writes retained part/literal evidence for a later missing verdict', async () => {
    const calls: string[] = [];
    let judgeCalls = 0;
    const model: StructuredGenerationPort = {
      generate: async input => {
        const current = role(input); calls.push(current);
        if (current === 'plan') return plan([{ question: 'Question' }]);
        if (current === 'judge') {
          judgeCalls += 1;
          return judgeCalls === 1
            ? judged([{ id: 'p1', status: 'partial', evidence_ids: ['old'], new_queries: ['follow-up'] }], true)
            : judged([{ id: 'p1', status: 'missing', evidence_ids: [] }], true);
        }
        if (current === 'writer') return { statements: [{ text: 'Retained evidence still matters.', evidence_ids: ['old'] }] };
        return { statement: null };
      },
    };
    const result = await composition(model, desk({ search: query => query === 'Question' ? { items: [item('old')], truncated: false } : query === 'follow-up' ? { items: [item('new')], truncated: false } : { items: [], truncated: false } })).answer({ question: 'Question' });
    expect(calls.filter(value => value === 'judge')).toHaveLength(2);
    expect(calls).toContain('writer');
    expect(result.parts[0]?.status).toBe('answered');
  });

  it('uses exact released fallback text after an empty-prose writer failure', async () => {
    let writerCalls = 0;
    const released = item('exact', { text: '  Exact immutable evidence\n' });
    const model: StructuredGenerationPort = {
      generate: async input => {
        switch (role(input)) {
          case 'plan': return plan([{ question: 'Question' }]);
          case 'judge': return judged([{ id: 'p1', status: 'answered', evidence_ids: ['exact'] }]);
          case 'writer': writerCalls += 1; return { statements: [{ text: '', evidence_ids: ['exact'] }] };
          case 'summary': return { statement: null };
        }
      },
    };
    const result = await composition(model, desk({ search: () => ({ items: [released], truncated: false }) })).answer({ question: 'Question' });
    expect(writerCalls).toBe(2);
    expect(result.parts[0]?.status).toBe('records_only');
    expect(result.parts[0]?.records?.[0]?.text).toBe('  Exact immutable evidence\n');
  });

  it('marks a summary private when any of its cited evidence is private', async () => {
    const model: StructuredGenerationPort = {
      generate: async input => {
        switch (role(input)) {
          case 'plan': return plan([{ question: 'Question' }]);
          case 'judge': return judged([{ id: 'p1', status: 'answered', evidence_ids: ['private'] }]);
          case 'writer': return { statements: [{ text: 'Private finding.', evidence_ids: ['private'] }] };
          case 'summary': return { statement: { text: 'Private summary.', evidence_ids: ['private'] } };
        }
      },
    };
    const result = await composition(model, desk({ search: () => ({ items: [item('private', { visibility: 'only_me' })], truncated: false }) })).answer({ question: 'Question' });
    expect(result.direct).toMatchObject({ text: 'Private summary.', private: true, citation_indexes: [0] });
  });

  it('does not infer an assumption for a name beyond the bounded near-spelling distance', async () => {
    let judges = 0;
    const model: StructuredGenerationPort = {
      generate: async input => {
        if (role(input) === 'plan') return plan([{ question: 'Eckoooo status' }]);
        if (role(input) === 'judge') { judges += 1; return { scope: { matches_question: false, note: 'Evidence is about Echo.' }, parts: [{ id: 'p1', status: 'missing', evidence_ids: [], new_queries: [] }], done: true }; }
        throw new Error('off-scope path must not write');
      },
    };
    const result = await composition(model, desk({ search: () => ({ items: [], truncated: false }) })).answer({ question: 'Eckoooo status' });
    expect(judges).toBe(1);
    expect(result.outcome).toBe('off_scope');
    expect(result.assumption).toBeUndefined();
  });

  it('keeps the twelve-call limit atomic across parallel writer repairs and keeps private summaries private', async () => {
    const calls: string[] = [];
    const five = Array.from({ length: 5 }, (_, index) => item(`e${index}`, { visibility: index === 0 ? 'only_me' : 'team' }));
    const model: StructuredGenerationPort = {
      generate: async input => {
        const current = role(input); calls.push(current);
        if (current === 'plan') return plan(Array.from({ length: 5 }, (_, index) => ({ question: `Part ${index + 1}` })));
        if (current === 'judge') return judged(Array.from({ length: 5 }, (_, index) => ({ id: `p${index + 1}`, status: 'answered' as const, evidence_ids: [`e${index}`] })));
        if (current === 'writer') return { malformed: true };
        return { statement: { text: 'Private summary.', evidence_ids: ['e0'] } };
      },
    };
    const entries: AgenticAskAuditEntryV1[] = [];
    const result = await composition(model, desk({ search: () => ({ items: five, truncated: false }) }), entries).answer({ question: 'All five' });
    expect(calls).toHaveLength(AGENTIC_ASK_MAX_MODEL_CALLS_V1);
    expect(calls.filter(value => value === 'summary')).toHaveLength(0);
    expect(entries[0]?.model_calls).toBe(AGENTIC_ASK_MAX_MODEL_CALLS_V1);
    expect(result.direct?.private ?? true).toBe(true);
  });
});
