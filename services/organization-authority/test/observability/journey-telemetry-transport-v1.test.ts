import { describe, expect, it } from 'vitest';
import { annotateCoreRuntimeV1, captureCoreRuntimeContentV1, observeCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { createJourneyTelemetryEventV1 } from '@echo-brain/organization-authority-kernel/shared/journey-telemetry-v1';
import { createJourneyTelemetryTransportFromEnvironmentV1, createJourneyTelemetryTransportV1 } from '../../src/composition/observability/journey-telemetry-transport-v1.js';
import { AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1, formatJourneyTelemetryMetricsV1, STAGING_JOURNEY_METRICS_NAMESPACE_V1 } from '../../src/composition/observability/journey-metrics-v1.js';

const identity = { release_sha: 'a'.repeat(40), build_number: 42 };
const observedAt = '2026-10-08T20:00:00.000Z';
const baked = { ECHO_STAGING_JOURNEY_TELEMETRY_V1: 'true', ECHO_SOURCE_SHA: identity.release_sha, ECHO_BUILD_NUMBER: String(identity.build_number) };
const scheduler = { set_interval: () => 1, clear_interval: () => undefined };
const event = (environment: 'staging' | 'production') => createJourneyTelemetryEventV1({
  journey_id: '00000000-0000-4000-8000-000000000001', sequence: 1, observed_at: observedAt,
  context: { environment, workflow: 'ask', ...identity },
  event: { stage: 'ask_response', event: 'succeeded', outcome: 'answered', elapsed_ms: 52 },
});

describe('shared operational telemetry transport', () => {
  it('counts unavailable provider usage and zero research totals without fabricating token or latency values', async () => {
    const lines: Record<string, unknown>[] = [];
    const transport = createJourneyTelemetryTransportV1('production', identity, { write: line => { lines.push(JSON.parse(line)); }, scheduler });
    await observeCoreRuntimeV1('research_run', async () => {
      await expect(observeCoreRuntimeV1('ask_planner', () => observeCoreRuntimeV1('model_call', async () => {
        throw Object.assign(new Error('PRIVATE'), { diagnostic: { failure_class: 'adapter_timeout' } });
      }))).rejects.toThrow('PRIVATE');
      annotateCoreRuntimeV1({ result: 'not_found', research_stop_reason: 'empty_catalog', counts: { planned_query_count: 0, query_hit_count: 0, released_atom_count: 0, context_atom_count: 0, citation_count: 0 } });
      // A renderer or output-view span is not another completed research run.
      await observeCoreRuntimeV1('research_output_view', async () => { annotateCoreRuntimeV1({ result: 'not_found', counts: { citation_count: 0 } }); });
    }, transport.core_runtime);
    const usage = lines.filter(line => line.LlmAttempt);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ stage: 'ask_planner', provider: 'other', model: 'other', LlmAttempt: 1, LlmUsageUnavailable: 1 });
    expect(usage[0]).not.toHaveProperty('LlmTotalTokens');
    expect(usage[0]).not.toHaveProperty('LlmProviderLatencyMs');
    expect(lines.filter(line => line.TerminalOutcome)).toEqual([expect.objectContaining({ stage: 'research_run', outcome: 'not_found', TerminalOutcome: 1 })]);
    expect(lines.filter(line => 'RetrievalCitations' in line)).toEqual([expect.objectContaining({ stage: 'research_run', RetrievalPlannedQueries: 0, RetrievalQueryHits: 0, RetrievalReleasedAtoms: 0, RetrievalContextAtoms: 0, RetrievalCitations: 0 })]);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'failed', failure_class: 'timeout', retryable: true }));
    expect(JSON.stringify(lines)).not.toContain('PRIVATE');
    transport.close();
  });

  it('emits production liveness, backlog and core resource spans, never model payloads', async () => {
    const lines: string[] = [];
    const transport = createJourneyTelemetryTransportFromEnvironmentV1('production', {
      ...baked, ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1: 'true',
    }, { write: line => { lines.push(line); }, now: () => observedAt, scheduler });
    expect(transport).toMatchObject({ enabled: true, environment: 'production', content_enabled: false, identity });
    expect(transport.core_runtime.content_observer).toBeUndefined();
    transport.start();
    await observeCoreRuntimeV1('ask_request', async () => {
      captureCoreRuntimeContentV1('model_request', { question: 'NEVER-PRODUCTION-CONTENT' });
    }, transport.core_runtime);
    transport.approved_search_backlog_observer({ observed_at: observedAt, pending_count: 0, stuck_count: 0, oldest_age_ms: null });
    transport.close();
    const records = lines.map(line => JSON.parse(line));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'echo-authority-journey-telemetry-liveness-v1', environment: 'production', ...identity }),
      expect.objectContaining({ kind: 'echo-authority-approved-search-backlog-v1', environment: 'production', pending_count: 0 }),
      expect.objectContaining({ kind: 'echo-authority-journey-stage-v1', environment: 'production', workflow: 'core_runtime', event: 'succeeded', diagnostic: expect.objectContaining({ phase: 'ask_request', root: true, counts: expect.objectContaining({ rss_bytes: expect.any(Number) }) }) }),
    ]));
    expect(records.filter(record => record._aws).every(record => record._aws.CloudWatchMetrics[0].Namespace === AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1)).toBe(true);
    expect(lines.join('')).not.toContain('NEVER-PRODUCTION-CONTENT');
    expect(lines.join('')).not.toContain('echo-authority-journey-content-v1');
  });

  it('keeps production content entrypoints inert even for hostile payload arguments', () => {
    const lines: string[] = [];
    const transport = createJourneyTelemetryTransportV1('production', identity, { write: line => { lines.push(line); }, scheduler }, { content_enabled: true });
    expect(() => transport.content_observer(new Proxy({}, { get() { throw new Error('must not inspect private payload'); } }) as Parameters<typeof transport.content_observer>[0])).not.toThrow();
    expect(lines).toEqual([]);
    transport.close();
  });

  it('requires canonical image capability and deploy identity in both environments', () => {
    for (const environment of ['staging', 'production'] as const) {
      for (const values of [
        { ...baked, ECHO_STAGING_JOURNEY_TELEMETRY_V1: undefined },
        { ...baked, ECHO_SOURCE_SHA: 'CUSTOMER-TEXT' },
        { ...baked, ECHO_BUILD_NUMBER: '01' },
        { ...baked, ECHO_BUILD_NUMBER: String(Number.MAX_SAFE_INTEGER + 1) },
      ]) {
        const transport = createJourneyTelemetryTransportFromEnvironmentV1(environment, values, { write: () => { throw new Error('disabled transport wrote'); } });
        expect(transport.enabled).toBe(false);
        expect(() => { transport.start(); transport.close(); }).not.toThrow();
      }
    }
  });

  it('rejects cross-environment and foreign-release events while stripping injected fields', () => {
    const lines: string[] = [];
    const transport = createJourneyTelemetryTransportV1('production', { ...identity, injected: 'MUST-NOT-PERSIST' } as typeof identity, { write: line => { lines.push(line); }, scheduler });
    expect(transport.identity).toEqual(identity);
    transport.observer(event('staging'));
    transport.observer({ ...event('production'), release_sha: 'b'.repeat(40) });
    expect(lines).toEqual([]);
    transport.observer({ ...event('production'), private_body: 'MUST-NOT-PERSIST' } as ReturnType<typeof event>);
    expect(lines.some(line => line.includes('echo-authority-journey-stage-v1'))).toBe(true);
    expect(lines.join('')).not.toContain('MUST-NOT-PERSIST');
    transport.close();
  });

  it('preserves historical metric names and dimensions while separating production from staging', () => {
    const staging = formatJourneyTelemetryMetricsV1(event('staging'));
    const production = formatJourneyTelemetryMetricsV1(event('production'));
    expect(staging).toHaveLength(2);
    expect(production).toHaveLength(staging.length);
    expect(staging.every(record => record._aws.CloudWatchMetrics[0].Namespace === STAGING_JOURNEY_METRICS_NAMESPACE_V1)).toBe(true);
    expect(production.every(record => record._aws.CloudWatchMetrics[0].Namespace === AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1)).toBe(true);
    expect(JSON.stringify(production).replaceAll(AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1, STAGING_JOURNEY_METRICS_NAMESPACE_V1)).toBe(JSON.stringify(staging));
    expect(production[0]).toMatchObject({ StageSucceeded: 1, StageClosedLatencyMs: 52 });
    expect(production[1]).toMatchObject({ TerminalOutcome: 1, outcome: 'answered' });
  });
});
