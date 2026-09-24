import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createPersonAnswerV2Route } from '../src/composition/person-answer-v2-route.js';
import type { AskJourneyTelemetryFactoryV1 } from '../src/composition/ask-journey-telemetry-v1.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const checked_at = '2026-09-23T00:00:00.000Z';
const authorization = Object.freeze({
  organization_id: 'org_fixture', principal_id: 'prn_fixture', membership_id: 'mem_fixture',
  membership_type: 'employee', session_family_id: 'psf_fixture', checked_at,
});

type OriginalFixturePort = {
  readonly retrieve: (input?: unknown) => {
    readonly release: {
      readonly authorization: typeof authorization;
      readonly scope: { readonly kind: 'global' };
      readonly authorization_revision: number;
      readonly released_atoms: readonly ReturnType<typeof source>[];
    };
    readonly query_hit_counts: readonly number[];
  };
  readonly revalidate: (input?: unknown) => { readonly checked_at: string };
  readonly read: () => never;
};

type RecordFixturePort = {
  readonly searchBatch: (input?: unknown) => unknown;
  readonly revalidateBatchRelease: (input?: unknown) => typeof authorization;
};

function source(index: number) {
  const character = 'abcdef'[index % 6]!;
  return Object.freeze({
    kind: 'source_revision' as const,
    source_id: `source:${character.repeat(64)}`,
    revision_id: `sha256:${String(index).padStart(64, '0')}`,
    source_sha256: digest(character),
    representation_sha256: digest(String((index + 1) % 10)),
    anchor_sha256: digest(String((index + 2) % 10)),
    label: `Source ${index}`,
    text: `source evidence ${index}`,
  });
}

function record(index: number) {
  const character = '123456789abcdef'[index % 15]!;
  return Object.freeze({
    atom_id: digest(character), record_sha256: digest(String((index + 3) % 10)),
    policy_id: 'organization-member-readable-person-v2' as const, text: `approved record ${index}`,
  });
}

function originals(
  atoms = [source(0)],
  hooks: { retrieve?: () => void; revalidate?: () => void } = {},
  query_hit_counts = [atoms.length],
) : OriginalFixturePort {
  const release = Object.freeze({ authorization, scope: Object.freeze({ kind: 'global' as const }), authorization_revision: 1, released_atoms: Object.freeze(atoms) });
  return {
    retrieve(input) {
      (input as { readonly on_authorized?: () => void } | undefined)?.on_authorized?.();
      hooks.retrieve?.();
      return Object.freeze({ release, query_hit_counts: Object.freeze(query_hit_counts) });
    },
    revalidate() { hooks.revalidate?.(); return Object.freeze({ checked_at }); },
    read() { throw new Error('not exercised'); },
  };
}

function records(
  items = [] as ReturnType<typeof record>[],
  query_hit_counts = [items.length],
) : RecordFixturePort {
  const release = Object.freeze({ initial_authorization: authorization, current_authorization: authorization,
    active_pointer: Object.freeze({ generation_id: digest('1'), manifest_sha256: digest('2'), retrieval_contract_sha256: digest('3'), record_head: Object.freeze({ position: 0, record_sha256: null }) }),
    record_read_audit_row_sha256: digest('4') });
  return {
    searchBatch: () => Object.freeze({ response: Object.freeze({ schema_version: 2, kind: 'echo-clean-person-record-search-v2', items: Object.freeze(items) }), release, query_hit_counts: Object.freeze(query_hit_counts) }),
    revalidateBatchRelease: () => authorization,
  };
}

function route(input: { originals?: ReturnType<typeof originals>; records?: ReturnType<typeof records>; generate: (call: number, prompt: string) => unknown; append?: (entry: unknown) => void; telemetry?: AskJourneyTelemetryFactoryV1 }) {
  let calls = 0;
  return createPersonAnswerV2Route({
    authority_id: 'oau_fixture', organization_id: authorization.organization_id, state_lineage_id: 'lineage_fixture',
    originals: (input.originals ?? originals()) as never,
    records: (input.records ?? records()) as never,
    model: { async generate(value: { readonly user_prompt: string }) { calls += 1; return input.generate(calls, value.user_prompt); } },
    generation: { generation_adapter_id: 'fixture', planner_model: 'planner', answer_model: 'answer', timeout_ms: 1_000 },
    audit: { append: (entry: unknown) => input.append?.(entry) } as never,
    ...(input.telemetry === undefined ? {} : { ask_journey_telemetry: input.telemetry }),
  });
}

function telemetryStages() {
  const events: Array<readonly [string, string]> = [];
  const telemetry: AskJourneyTelemetryFactoryV1 = {
    start: () => ({
      journey_id: null,
      startTimer: () => 0,
      succeed: (stage) => { events.push([stage, 'succeeded']); },
      fail: (stage) => { events.push([stage, 'failed']); },
      skip: () => undefined,
      observeComposition: () => undefined,
      observeContent: () => undefined,
      complete: () => undefined,
      terminate: () => undefined,
    }),
  };
  return { telemetry, events };
}

const request = { schema_version: 2 as const, question: 'What is ready?' };

describe('V2 global/project Ask composition', () => {
  it('retrieves before the only model call, eliminating planner-shape failures', async () => {
    const events: string[] = [];
    const app = route({
      originals: originals([source(0)], { retrieve: () => { events.push('retrieve'); } }),
      generate: (_call, prompt) => {
        events.push('answer');
        expect(prompt).toContain('source evidence 0');
        return { answer: { text: 'Grounded answer.', citations: ['a1'] } };
      },
    });
    await expect(app.ask({ access_token: 'token', request })).resolves.toMatchObject({ answer: 'Grounded answer.' });
    expect(events).toEqual(['retrieve', 'answer']);
  });

  it('makes no model call for an empty authorized evidence release', async () => {
    let calls = 0;
    const app = route({ originals: originals([]), records: records([]), generate: () => { calls += 1; throw new Error('No evidence'); } });
    await expect(app.ask({ access_token: 'token', request })).resolves.toMatchObject({ citations: [], answer: 'Insufficient accessible evidence to answer this question.' });
    expect(calls).toBe(0);
  });

  it('records validation, authorization, and combined retrieval stages for source evidence', async () => {
    const journey = telemetryStages();
    const app = route({
      telemetry: journey.telemetry,
      generate: () => ({ answer: { text: 'The source is ready.', citations: ['a1'] } }),
    });
    await expect(app.ask({ access_token: 'token', request })).resolves.toBeDefined();
    expect(journey.events).toEqual(expect.arrayContaining([
      ['ask_validation', 'succeeded'],
      ['ask_authorization', 'succeeded'],
      ['ask_retrieval', 'succeeded'],
    ]));
  });

  it('records an authorization failure when original scope authorization cannot release evidence', async () => {
    const journey = telemetryStages();
    const port = originals();
    const app = route({
      telemetry: journey.telemetry,
      originals: { ...port, retrieve: () => { throw new AuthorityOperationError('unauthorized', 'scope denied'); } },
      generate: () => ({ answer: { text: 'unreachable', citations: [] } }),
    });
    await expect(app.ask({ access_token: 'token', request })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(journey.events).toContainEqual(['ask_authorization', 'failed']);
  });

  it('answers from originals when the approved-record generation is valid but empty', async () => {
    const app = route({ generate: () => ({ answer: { text: 'The source is ready.', citations: ['a1'] } }) });
    const result = await app.ask({ access_token: 'token', request });
    expect(result.scope).toEqual({ kind: 'global' });
    expect(result.citations).toEqual([expect.objectContaining({ kind: 'source_revision', label: 'Source 0' })]);
    expect(result.citations[0]).not.toHaveProperty('text');
  });

  it('audits the exact validated V3 response, including its scope and source citation kind', async () => {
    let entry: { readonly response_sha256: string } | undefined;
    const app = route({
      generate: () => ({ answer: { text: 'The source is ready.', citations: ['a1'] } }),
      append: value => { entry = value as { readonly response_sha256: string }; },
    });
    const response = await app.ask({ access_token: 'token', request });
    expect(entry?.response_sha256).toBe(canonicalSha256(response));
  });

  it('withholds an answer when deferred revalidation revokes an uncited supplied source', async () => {
    let audited = 0;
    const app = route({
      originals: originals([source(0), source(1)], { revalidate: () => { throw new AuthorityOperationError('unauthorized', 'revoked after model'); } }),
      generate: () => ({ answer: { text: 'Only the first source.', citations: ['a1'] } }),
      append: () => { audited += 1; },
    });
    await expect(app.ask({ access_token: 'token', request })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(audited).toBe(0);
  });

  it('port ordering: does not invoke the answerer when source retrieval fails', async () => {
    let generates = 0;
    const app = route({
      originals: originals([source(0)], { retrieve: () => { throw new AuthorityOperationError('unavailable', 'source audit failed'); } }),
      generate: () => { generates += 1; return { answer: { text: 'must not run', citations: ['a1'] } }; },
    });
    await expect(app.ask({ access_token: 'token', request })).rejects.toMatchObject({ code: 'unavailable' });
    expect(generates).toBe(0); // Authorization and retrieval precede every model call.
  });

  it('port ordering: does not erase the original-read event when answer generation fails', async () => {
    const auditEvents: string[] = [];
    const app = route({
      originals: originals([source(0)], { retrieve: () => { auditEvents.push('original-read'); } }),
      generate: () => { throw new Error('provider failed'); },
      append: () => { auditEvents.push('answer-audit'); },
    });
    await expect(app.ask({ access_token: 'token', request })).rejects.toMatchObject({ code: 'unavailable' });
    expect(auditEvents).toEqual(['original-read']);
  });

  it('interleaves the five approved records and five originals in a single-query release', async () => {
    let answerPrompt = '';
    const app = route({
      originals: originals(Array.from({ length: 5 }, (_, index) => source(index)), {}, [5]),
      records: records(Array.from({ length: 5 }, (_, index) => record(index)), [5]),
      generate: (_call, prompt) => {
        answerPrompt = prompt;
        return { answer: { text: 'Mixed evidence.', citations: ['a1', 'a2'] } };
      },
    });
    await expect(app.ask({ access_token: 'token', request })).resolves.toMatchObject({ citations: [{ kind: 'approved_record' }, { kind: 'source_revision' }] });
    expect(answerPrompt).toContain('approved record 4');
    expect(answerPrompt).toContain('source evidence 4');
    expect(answerPrompt).not.toContain('approved record 5');
    expect(answerPrompt).not.toContain('source evidence 5');
  });

  it('keeps selected project scope and never searches unassociated approved records', async () => {
    const project_id = 'prj_00000000-0000-4000-8000-000000000001';
    const scopes: unknown[] = [];
    let recordSearches = 0;
    const originalPort = originals();
    const recordPort = records();
    const app = route({
      originals: {
        ...originalPort,
        retrieve(input: { readonly scope: unknown }) {
          scopes.push(input.scope);
          const retrieved = originalPort.retrieve(input);
          return Object.freeze({
            ...retrieved,
            release: Object.freeze({ ...retrieved.release, scope: input.scope }),
          });
        },
      } as never,
      records: {
        ...recordPort,
        searchBatch() {
          recordSearches += 1;
          return recordPort.searchBatch();
        },
      } as never,
      generate: () => ({ answer: { text: 'Project source is ready.', citations: ['a1'] } }),
    });

    await expect(app.ask({
      access_token: 'token',
      request: { schema_version: 2, question: 'What is ready?', project_id },
    })).resolves.toMatchObject({ scope: { kind: 'project', project_id } });
    expect(scopes).toEqual([{ kind: 'project', project_id }]);
    expect(recordSearches).toBe(0);
  });

  it('does not fall back to originals when the valid approved-record generation cannot be read', async () => {
    let generates = 0;
    const unavailableRecords = {
      searchBatch() { throw new AuthorityOperationError('unavailable', 'generation unavailable'); },
      revalidateBatchRelease() { return authorization; },
    } as never;
    const app = route({
      records: unavailableRecords,
      generate: () => { generates += 1; return { answer: { text: 'must not run', citations: ['a1'] } }; },
    });

    await expect(app.ask({ access_token: 'token', request })).rejects.toMatchObject({ code: 'unavailable' });
    expect(generates).toBe(0); // A failed release cannot reach the model.
  });

  it('maps an answerer citation outside the released evidence to invalid_output', async () => {
    const app = route({
      generate: () => ({ answer: { text: 'Unverifiable answer.', citations: ['a2'] } }),
    });

    await expect(app.ask({ access_token: 'token', request })).rejects.toMatchObject({ code: 'invalid_output' });
  });
});
