import { describe, expect, it, vi } from 'vitest';
import {
  annotateCoreRuntimeV1, coreRuntimeDiagnosticErrorKindV1, coreRuntimeIdentityV1,
  currentCoreRuntimeDetailV1, normalizeCoreRuntimeDetailV1,
  observeCoreRuntimeDiagnosticV1, observeCoreRuntimeRootV1, observeCoreRuntimeSyncV1, observeCoreRuntimeV1,
  withCoreRuntimeDiagnosticsV1, withoutCoreRuntimeContentV1,
  type CoreRuntimeDiagnosticObservationV1, type CoreRuntimeObservationV1,
} from '../../src/shared/core-runtime-observation-v1.js';
import { createJourneyTelemetryEventV1 } from '../../src/shared/journey-telemetry-v1.js';

const payload = () => ({ kind: 'tool_response' as const, tool_call_id: 1, round: 1, tool: 'open' as const, result: { text: 'private released text', results: [{ id: 'E2' }] } });
const vocabulary = { providers: [], models: [], triggers: ['ask', 'approved_record', 'future_trigger'] };

describe('shared selected-run diagnostics', () => {
  it('uses the existing operation/span identity and never sends payloads to metadata', async () => {
    const metadata: CoreRuntimeObservationV1[] = [];
    const diagnostics: CoreRuntimeDiagnosticObservationV1[] = [];
    await observeCoreRuntimeV1('http_request', async () => withCoreRuntimeDiagnosticsV1(event => { diagnostics.push(event); }, async () => {
      await observeCoreRuntimeV1('research_run', async () => {
        annotateCoreRuntimeV1({ trigger: 'ask', run_id: coreRuntimeIdentityV1('run', 'private-run'), research_stop_reason: 'budget', research_admission: 'post_revalidation_no_time' });
        await observeCoreRuntimeV1('evidence_open', async () => observeCoreRuntimeDiagnosticV1(payload()));
      });
    }), { vocabulary, observer: event => { metadata.push(event); } });
    const open = metadata.find(event => event.phase === 'evidence_open' && event.event === 'started')!;
    expect(diagnostics).toEqual([{ ...payload(), operation_id: open.operation_id, span_id: open.span_id, parent_span_id: open.parent_span_id }]);
    expect(new Set(metadata.map(event => event.operation_id)).size).toBe(1);
    expect(JSON.stringify(metadata)).not.toMatch(/private released text|private-run/);
    expect(open).toMatchObject({ trigger: 'ask', run_id: coreRuntimeIdentityV1('run', 'private-run') });
    expect(metadata.find(event => event.phase === 'research_run' && event.event === 'succeeded')).toMatchObject({ research_stop_reason: 'budget', research_admission: 'post_revalidation_no_time' });
  });

  it('supports diagnostic-only scopes and preserves synchronous and asynchronous results', async () => {
    const diagnostics: CoreRuntimeDiagnosticObservationV1[] = [];
    const observer = (event: CoreRuntimeDiagnosticObservationV1) => { diagnostics.push(event); };
    const value = withCoreRuntimeDiagnosticsV1(observer, () => observeCoreRuntimeSyncV1('research_brief', () => {
      observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'brief', event: 'succeeded', data: { goal: 'private question' } });
      return 42;
    }));
    expect(value).toBe(42);
    await expect(withCoreRuntimeDiagnosticsV1(observer, () => observeCoreRuntimeV1('research_loop', async () => {
      await Promise.resolve(); observeCoreRuntimeDiagnosticV1(payload()); return 43;
    }))).resolves.toBe(43);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.operation_id).not.toBe(diagnostics[1]!.operation_id);
    expect(diagnostics.every(event => event.parent_span_id === null)).toBe(true);
    const failure = new Error('business failure');
    expect(() => withCoreRuntimeDiagnosticsV1(observer, () => observeCoreRuntimeSyncV1('research_brief', () => { throw failure; }))).toThrow(failure);
  });

  it('isolates nested and concurrent selections and preserves the live-content fence', async () => {
    const selected: CoreRuntimeDiagnosticObservationV1[][] = [[], []];
    const legacy = vi.fn();
    await Promise.all(selected.map(events => observeCoreRuntimeV1('research_run', async () => {
      await Promise.resolve();
      withoutCoreRuntimeContentV1(() => observeCoreRuntimeDiagnosticV1(payload()));
      withCoreRuntimeDiagnosticsV1(undefined, () => observeCoreRuntimeDiagnosticV1(payload()));
    }, { diagnostic_observer: event => { events.push(event); }, content_observer: legacy })));
    expect(selected.map(events => events.length)).toEqual([1, 1]);
    expect(selected[0]![0]!.operation_id).not.toBe(selected[1]![0]!.operation_id);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('detaches background work from the HTTP lifetime and inherits metadata but not selected payload capture', async () => {
    const metadata: CoreRuntimeObservationV1[] = [];
    const parentDiagnostics = vi.fn();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let background!: Promise<number>;
    await observeCoreRuntimeV1('http_request', async () => {
      background = observeCoreRuntimeRootV1('research_run', async () => {
        await pending;
        annotateCoreRuntimeV1({ trigger: 'approved_record', run_id: coreRuntimeIdentityV1('run', 'background'), attempt: 2 });
        observeCoreRuntimeDiagnosticV1(payload());
        return 5;
      });
    }, { vocabulary, observer: event => { metadata.push(event); }, diagnostic_observer: parentDiagnostics });
    const http = metadata.find(event => event.phase === 'http_request' && event.event === 'started')!;
    const child = metadata.find(event => event.phase === 'research_run' && event.event === 'started')!;
    expect(child).toMatchObject({ root: true, parent_span_id: null, parent_operation_id: http.operation_id, linked_journey_ids: [http.operation_id] });
    expect(child.operation_id).not.toBe(http.operation_id);
    expect(metadata.at(-1)).toMatchObject({ phase: 'http_request', event: 'succeeded' });
    release();
    await expect(background).resolves.toBe(5);
    expect(metadata.at(-1)).toMatchObject({ phase: 'research_run', event: 'succeeded', trigger: 'approved_record', attempt: 2 });
    expect(parentDiagnostics).not.toHaveBeenCalled();
  });

  it('captures a detached run only when that run explicitly selects its sink', async () => {
    const parent = vi.fn(); const child = vi.fn();
    await observeCoreRuntimeV1('http_request', async () => {
      await observeCoreRuntimeRootV1('research_run', async () => observeCoreRuntimeDiagnosticV1(payload()), { diagnostic_observer: child });
    }, { diagnostic_observer: parent });
    expect(parent).not.toHaveBeenCalled(); expect(child).toHaveBeenCalledTimes(1);
  });

  it('copies snapshots and isolates mutations, errors and rejected observer promises', async () => {
    const source = payload();
    const diagnostics: CoreRuntimeDiagnosticObservationV1[] = [];
    await observeCoreRuntimeV1('research_run', async () => {
      observeCoreRuntimeDiagnosticV1(source);
      source.result.text = 'changed afterwards';
    }, { diagnostic_observer: event => { diagnostics.push(event); if (event.kind === 'tool_response') (event.result.results as { id: string }[])[0]!.id = 'mutated'; throw new Error('observer'); } });
    expect(source.result.results[0]!.id).toBe('E2');
    expect(diagnostics[0]).toMatchObject({ result: { text: 'private released text' } });
    await expect(observeCoreRuntimeV1('research_run', async () => { observeCoreRuntimeDiagnosticV1(payload()); return 7; }, { diagnostic_observer: async () => { throw new Error('async observer'); } })).resolves.toBe(7);
  });

  it('marks non-JSON snapshots as capture loss without evaluating getters', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const getter = vi.fn(() => 'private getter');
    const data = Object.defineProperty({}, 'dangerous', { enumerable: true, get: getter });
    await observeCoreRuntimeV1('research_run', async () => {
      observeCoreRuntimeDiagnosticV1({ kind: 'model_response', call_id: 1, role: 'step', value: data });
    }, { diagnostic_observer: event => { events.push(event); } });
    expect(getter).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ kind: 'capture_error', error_kind: 'snapshot_failed', operation_id: expect.any(String), span_id: expect.any(String) })]);
    expect(coreRuntimeDiagnosticErrorKindV1(new Proxy({}, { get() { throw new Error('private getter'); } }))).toBe('other');
  });

  it('keeps correlation finite and opaque through the journey contract', async () => {
    let detail = null as ReturnType<typeof currentCoreRuntimeDetailV1>;
    await observeCoreRuntimeV1('research_run', async () => {
      annotateCoreRuntimeV1({ trigger: 'future_trigger', run_id: coreRuntimeIdentityV1('run', 'r'), event_id: coreRuntimeIdentityV1('event', 'e'), output_id: coreRuntimeIdentityV1('output', 'o'), attempt_id: coreRuntimeIdentityV1('attempt', 'a'), attempt: 1 });
      detail = currentCoreRuntimeDetailV1();
    }, { vocabulary, observer: () => undefined });
    expect(detail).toMatchObject({ trigger: 'future_trigger', attempt: 1 });
    const event = createJourneyTelemetryEventV1({ journey_id: detail!.operation_id, sequence: 1, observed_at: '2026-10-08T20:00:00.000Z', context: { environment: 'production', workflow: 'core_runtime' }, event: { stage: 'core_operation', event: 'succeeded', elapsed_ms: 1, diagnostic: detail! } }, vocabulary);
    expect(event.diagnostic).toMatchObject({ trigger: 'future_trigger', run_id: coreRuntimeIdentityV1('run', 'r') });
    expect(normalizeCoreRuntimeDetailV1({ ...detail!, trigger: 'private request text' }, vocabulary)).toMatchObject({ trigger: 'other' });
    for (const key of ['run_id', 'event_id', 'output_id', 'attempt_id'] as const) expect(() => normalizeCoreRuntimeDetailV1({ ...detail!, [key]: 'private source text' }, vocabulary)).toThrow('opaque');
  });
});
