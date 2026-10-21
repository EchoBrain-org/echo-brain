import type { AgenticModelGateV1 } from './agentic-model-gate-v1.js';
import { AgenticAskOutputErrorV1, type StepPart } from './agentic-ask-v1-model-protocol.js';
import { object } from './agentic-model-gate-v1.js';

/** Optional research harness. ECHO owns sources, tool state, completion and release. */
export interface AgenticResearchDriverV1 {
  run(session: AgenticResearchDriverSessionV1): Promise<void>;
}

/** Native harness notes are not constrained by the old step protocol's numerical caps. */
export function parseAgenticDriverFinishV1(value: unknown, question: boolean): { readonly completed: boolean; readonly parts: readonly StepPart[] } {
  const body = object(value);
  if (body === null || typeof body.completed !== 'boolean' || !Array.isArray(body.parts) || body.parts.length === 0) throw new AgenticAskOutputErrorV1('finish requires completed and nonempty parts');
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new AgenticAskOutputErrorV1(`${field} must be nonempty text`);
    return value;
  };
  return { completed: body.completed, parts: body.parts.map(raw => {
    const part = object(raw);
    if (part === null || !Array.isArray(part.needs) || part.needs.length === 0 || typeof part.notes !== 'string') throw new AgenticAskOutputErrorV1('Each part needs notes and nonempty needs');
    return { question: text(part.question, 'question'), notes: part.notes, needs: part.needs.map(raw => {
      const need = object(raw);
      if (need === null || !['open', 'found', 'not_found'].includes(String(need.status)) || !Array.isArray(need.evidence) || !need.evidence.every(id => typeof id === 'string' && /^[EL][1-9][0-9]*$/u.test(id))) throw new AgenticAskOutputErrorV1('Invalid need status or E/L evidence ids');
      if (question && !['content', 'which_items', 'which_say'].includes(String(need.kind))) throw new AgenticAskOutputErrorV1('Need kind must be content, which_items or which_say');
      return { need: text(need.need, 'need'), status: need.status as 'open' | 'found' | 'not_found', evidence: need.evidence as string[],
        ...(question ? { kind: need.kind as 'content' | 'which_items' | 'which_say' } : {}) };
    }) };
  }) };
}

/** No credentials, raw desk ids, provider cursors or trigger identity cross this port. */
export interface AgenticResearchDriverSessionV1 {
  readonly initial: Readonly<Record<string, unknown>>;
  readonly list_available: boolean;
  readonly question: boolean;
  readonly signal: AbortSignal;
  /** Research time left, with the unchanged writer/finalization reserves excluded. */
  readonly remaining: () => number;
  /** Every outbound model request, including retries/compaction, must use this gate. */
  readonly model_request: AgenticModelGateV1['external'];
  /** Read tools and finish return only request-owned evidence and validation feedback. */
  call(tool: 'search' | 'list' | 'open' | 'finish', args: unknown): Promise<Readonly<Record<string, unknown>>>;
}
