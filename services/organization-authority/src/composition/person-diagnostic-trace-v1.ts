import {
  PERSON_DIAGNOSTICS_MAX_TRACE_BYTES_V1,
  PERSON_DIAGNOSTICS_MAX_TRACE_DEPTH_V1,
  PERSON_DIAGNOSTICS_MAX_TRACE_EVENTS_V1,
  type PersonDiagnosticTraceV1,
} from '@echo-brain/organization-api';

/** One private, bounded prefix for a selected ordinary product request. */
export function createPersonDiagnosticTraceV1(now: () => number) {
  const events: string[] = [];
  let eventBytes = 0;
  let dropped = 0;
  let sealed = false;
  let closed = false;
  // Reserve the largest possible dropped counter, so overflow reporting itself
  // can never push the complete serialized envelope beyond its byte limit.
  const envelopeBytes = Buffer.byteLength(JSON.stringify({
    schema_version: 1, kind: 'echo-agentic-research-trace-v1', complete: false,
    events: [], dropped_events: Number.MAX_SAFE_INTEGER,
  }));
  const drop = () => { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); };
  const depthFits = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== 'object') return true;
    return depth < PERSON_DIAGNOSTICS_MAX_TRACE_DEPTH_V1 && Object.values(value).every(child => depthFits(child, depth + 1));
  };

  return Object.freeze({
    record(event: Readonly<Record<string, unknown>>): void {
      if (closed || sealed) return;
      // Keep an exact prefix. A later smaller event must not make a trace with
      // a missing middle appear continuous or leave the loss unexplained.
      try {
        if (dropped > 0 || events.length >= PERSON_DIAGNOSTICS_MAX_TRACE_EVENTS_V1 || event.kind === 'capture_error') { drop(); return; }
        const serialized = JSON.stringify({ ...event, sequence: events.length + 1, observed_at: new Date(now()).toISOString() });
        const size = Buffer.byteLength(serialized) + (events.length === 0 ? 0 : 1);
        if (envelopeBytes + eventBytes + size > PERSON_DIAGNOSTICS_MAX_TRACE_BYTES_V1) { drop(); return; }
        // The response validator starts at the trace envelope; its events
        // array is depth one and an individual event is depth two.
        if (!depthFits(JSON.parse(serialized), 2)) { drop(); return; }
        // Storing serialized events snapshots nested values without retaining
        // an observer's reference to model inputs or released source bodies.
        events.push(serialized);
        eventBytes += size;
      } catch { drop(); }
    },
    snapshot(): PersonDiagnosticTraceV1 {
      return Object.freeze({
        schema_version: 1 as const, kind: 'echo-agentic-research-trace-v1' as const,
        complete: dropped === 0, events: Object.freeze(events.map(event => JSON.parse(event) as Readonly<Record<string, unknown>>)), dropped_events: dropped,
      });
    },
    seal(): void { sealed = true; },
    close(): void { closed = true; events.length = 0; eventBytes = 0; },
  });
}

export type PersonDiagnosticTraceCollectorV1 = ReturnType<typeof createPersonDiagnosticTraceV1>;
