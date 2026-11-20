import { EvidenceDeskSnapshotChangedV1 } from "../../src/shared/evidence-desk-v1.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1, AgenticAskStalledErrorV1, AgenticModelStalledErrorV1, AgenticModelUnsettledErrorV1, createAgenticModelGateV1, raceAbort } from "../../src/answer-composition/agentic-model-gate-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { observeCoreRuntimeV1, withCoreRuntimeDiagnosticsV1, type CoreRuntimeDiagnosticObservationV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import { AgenticAskOutputErrorV1, cleanLine, repairInput, repairInstruction } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { StructuredGenerationInput, StructuredGenerationJsonSchema } from "../../src/answer-composition/structured-generation-v1.js";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 32_768, max_output_tokens: 8_000 };
const schema = { type: "object" } as unknown as StructuredGenerationJsonSchema;
/** Ask's two calls: the role the audit records and the runtime span each runs in. */
const STEP = { role: "step", span: "ask_planner" } as const;
const ANSWER = { role: "answer", span: "ask_answer" } as const;

function harness(options: {
  readonly replies?: readonly (unknown | Error)[];
  readonly desk_revalidate?: () => Promise<{ readonly checked_at: string }>;
  readonly modes?: string[];
  readonly signal?: AbortSignal;
  readonly model?: Parameters<typeof createAgenticModelGateV1>[0]["model"];
} = {}) {
  const trace: string[] = [];
  const inputs: StructuredGenerationInput[] = [];
  const replies = [...(options.replies ?? [])];
  const checked: string[] = [];
  const gate = createAgenticModelGateV1({
    generation,
    model: options.model ?? {
      async generate(input) {
        trace.push(`generate:${inputs.length}`); inputs.push(input);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    desk_revalidate: async ({ mode }) => {
      trace.push("revalidate"); options.modes?.push(mode);
      return options.desk_revalidate?.() ?? { checked_at: `2026-10-06T00:00:0${checked.length}.000Z` };
    },
    on_checked: at => { checked.push(at); },
    now: () => 0,
    signal: options.signal ?? new AbortController().signal,
  });
  return { gate, trace, inputs, checked };
}

describe("agentic model gate", () => {
  it('does not revalidate or account for an expired native request, and admits a fresh writer attempt', async () => {
    const expired = new Error('writer expired');
    let attempts = 0, forwarded = 0;
    const { gate, trace } = harness({ model: {
      generate: async () => false,
      generate_with_admission: async (input, admit) => admit({ model: input.model, operation: 'messages',
        body_sha256: canonicalSha256('writer'),
        signal: attempts++ === 0 ? AbortSignal.abort(expired) : new AbortController().signal,
      }, async () => { forwarded++; return { value: true }; }),
    } });
    await expect(gate.call(ANSWER, 'system', {}, schema)).rejects.toBe(expired);
    expect(trace).toEqual([]); expect(gate.stats().calls).toBe(0);
    await expect(gate.call(ANSWER, 'system', {}, schema)).resolves.toBe(true);
    expect(trace).toEqual(['revalidate']); expect(forwarded).toBe(1); expect(gate.stats().calls).toBe(1);
  });
  it('admits each native writer request as an answer, including retries and token counts, without double counting the session', async () => {
    const forwarded: string[] = [];
    const { gate, trace } = harness({ model: {
      generate: async () => { throw new Error('must use native admission'); },
      generate_with_admission: async (input, admit) => {
        for (const operation of ['messages', 'messages', 'count_tokens'] as const) {
          await admit({ model: input.model, operation, body_sha256: canonicalSha256(operation) }, async () => {
            forwarded.push(operation); return { value: true, finish_reason: 'stop' };
          });
        }
        return { answer: true };
      },
    } });
    await expect(gate.call(ANSWER, 'system', {}, schema)).resolves.toEqual({ answer: true });
    expect(trace).toEqual(['revalidate', 'revalidate', 'revalidate']);
    expect(forwarded).toEqual(['messages', 'messages', 'count_tokens']);
    expect(gate.stats()).toMatchObject({ calls: 3, generations: Array.from({ length: 3 }, () => ({ role: 'answer', engine: 'external_writer', model: generation.answer_model })) });
  });

  it('stops native writer requests after access is revoked, including a subsequent SDK attempt', async () => {
    let checks = 0, forwarded = 0;
    const { gate } = harness({
      desk_revalidate: async () => { if (++checks === 2) throw new AuthorityOperationError('unauthorized', 'revoked'); return { checked_at: 'now' }; },
      model: { generate: async () => { throw new Error('shared writer must not run'); }, generate_with_admission: async (input, admit) => {
        const send = () => admit({ model: input.model, operation: 'messages', body_sha256: canonicalSha256('writer') }, async () => { forwarded++; return { value: true }; });
        await send();
        const errors = await Promise.allSettled([send(), send()]);
        expect(errors.map(value => value.status)).toEqual(['rejected', 'rejected']);
        throw (errors[0] as PromiseRejectedResult).reason;
      } },
    });
    await expect(gate.call(ANSWER, 'system', {}, schema)).rejects.toBeInstanceOf(Error);
    expect(forwarded).toBe(1); expect(gate.stats().calls).toBe(1);
    expect(checks).toBe(2);
  });

  it('pairs native SDK payloads and visible responses in the private trace without adding content to the audit', async () => {
    const { gate } = harness();
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const request = { model: 'claude-fixture', body_sha256: canonicalSha256('synthetic'), operation: 'messages' as const,
      diagnostic_input: { model: 'claude-fixture', system_prompt: 'synthetic system', user_prompt: 'private fixture', schema: {}, max_output_tokens: 100, timeout_ms: 20_000 } };
    await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => gate.external(request, async () => ({ value: [{ type: 'text', text: 'private answer' }], finish_reason: 'stop' })));
    expect(events.filter(event => event.kind === 'model_request')).toEqual([expect.objectContaining({ call_id: 1, input: request.diagnostic_input })]);
    expect(events.filter(event => event.kind === 'model_response')).toEqual([expect.objectContaining({ call_id: 1, value: [{ type: 'text', text: 'private answer' }], finish_reason: 'stop' })]);
    expect(JSON.stringify(gate.stats())).not.toMatch(/private fixture|private answer|synthetic system/);
  });

  it('fences and audits every external inference, retry and token count with its actual body digest', async () => {
    const { gate, trace } = harness();
    const body_sha256 = canonicalSha256({ messages: ['synthetic evidence'] });
    for (const operation of ['messages', 'messages', 'count_tokens'] as const) {
      await gate.external({ model: 'claude-fixture', body_sha256, operation }, async () => {
        trace.push('forward'); return { value: true, finish_reason: 'end_turn' };
      });
    }
    expect(trace).toEqual(['revalidate', 'forward', 'revalidate', 'forward', 'revalidate', 'forward']);
    expect(gate.stats()).toMatchObject({ calls: 3, generations: Array.from({ length: 3 }, () => ({ role: 'step', finish_reason: 'end_turn', usage: null })) });
    expect(gate.stats().invocation_digests).toEqual(['messages', 'messages', 'count_tokens'].map(operation => canonicalSha256({ engine: 'external_research', model: 'claude-fixture', body_sha256, operation })));
  });

  it('latches external access loss across concurrent calls even if access later returns', async () => {
    let revoked = true; let forwarded = 0;
    const { gate } = harness({ desk_revalidate: async () => {
      if (revoked) throw new AuthorityOperationError('unauthorized', 'revoked'); return { checked_at: 'now' };
    } });
    const send = () => gate.external({ model: 'claude-fixture', body_sha256: canonicalSha256('body'), operation: 'messages' }, async () => { forwarded++; return { value: true }; });
    const results = await Promise.allSettled([send(), send()]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    revoked = false;
    await expect(send()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(forwarded).toBe(0); expect(gate.stats().calls).toBe(0);
  });

  it('counts no calls: concurrent external requests and the writer after them are all admitted', async () => {
    const { gate } = harness({ replies: [{ answer: true }] });
    let forwarded = 0;
    const send = () => gate.external({ model: 'claude-fixture', body_sha256: canonicalSha256('body'), operation: 'messages' }, async () => { forwarded++; return { value: true }; });
    const results = await Promise.allSettled(Array.from({ length: 80 }, send));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(forwarded).toBe(80);
    await expect(gate.call(ANSWER, 'answer', {}, schema)).resolves.toEqual({ answer: true });
  });

  it('does not forward an external request after cancellation during its access check', async () => {
    const controller = new AbortController(); let forwarded = false;
    const { gate } = harness({ signal: controller.signal, desk_revalidate: async () => { controller.abort(); return { checked_at: 'now' }; } });
    await expect(gate.external({ model: 'claude-fixture', body_sha256: canonicalSha256('body'), operation: 'messages' }, async () => { forwarded = true; return { value: true }; })).rejects.toMatchObject({ name: 'AbortError' });
    expect(forwarded).toBe(false);
  });

  it('names an external request that sent nothing for its silence period a stall, and keeps the writer available', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const { gate } = harness({ signal: caller.signal, replies: [{ answer: true }] });
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    try {
      const pending = withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => gate.external({
        model: 'claude-fixture', body_sha256: canonicalSha256('timeout'), operation: 'messages',
        diagnostic_input: { model: 'claude-fixture', system_prompt: '', user_prompt: '', schema: {}, max_output_tokens: 100, timeout_ms: 4_000 },
      }, signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })));
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(generation.timeout_ms);
      const error = await settled;
      expect(error).toBeInstanceOf(AgenticModelStalledErrorV1);
      expect(error).toMatchObject({ message: 'the model sent nothing for 30 s', recovery: 'fallback' });
      expect(error).not.toHaveProperty('diagnostic');
      expect(caller.signal.aborted).toBe(false);
      expect(gate.stats()).toMatchObject({ calls: 1, stopped: false, generations: [{ role: 'step', finish_reason: null }] });
      expect(events.filter(event => event.kind === 'model_error')).toEqual([expect.objectContaining({ error_kind: 'adapter_timeout' })]);
      await expect(gate.call(ANSWER, 'answer', {}, schema)).resolves.toEqual({ answer: true });
    } finally { vi.useRealTimers(); }
  });

  it('lets an external request that keeps reporting progress run past its silence period, never stopping it', async () => {
    vi.useFakeTimers();
    const { gate } = harness();
    try {
      let aborted = false;
      const pending = gate.external({ model: 'claude-fixture', body_sha256: canonicalSha256('streaming'), operation: 'messages' }, (signal, progress) => new Promise<{ readonly value: string }>(resolve => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        let pieces = 0;
        const tick = setInterval(() => { progress?.(); if (++pieces === 90) { clearInterval(tick); resolve({ value: 'whole reply' }); } }, 1_000);
      }));
      await vi.advanceTimersByTimeAsync(3 * generation.timeout_ms);
      await expect(pending).resolves.toBe('whole reply');
      expect(aborted).toBe(false);
      expect(gate.stats()).toMatchObject({ calls: 1, stopped: false });
    } finally { vi.useRealTimers(); }
  });

  it.each(['caller', 'stall'] as const)('keeps an overall %s abort terminal when the external silence also passes', async reason => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const { gate } = harness({ signal: caller.signal });
    const failure = reason === 'caller' ? new DOMException('cancelled', 'AbortError') : new AgenticAskStalledErrorV1('read', 120_000);
    try {
      const pending = gate.external({ model: 'claude-fixture', body_sha256: canonicalSha256('abort'), operation: 'messages' },
        signal => new Promise((_resolve, reject) => {
          // The request stops at the moment its silence passes.
          signal.addEventListener('abort', () => { caller.abort(failure); reject(signal.reason); }, { once: true });
        })).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(generation.timeout_ms);
      expect(await pending).toMatchObject({ name: failure.name });
      expect(gate.stats().generations).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("revalidates the desk once before every model call and reports the check time", async () => {
    const { gate, trace, checked } = harness({ replies: [{ a: 1 }, { b: 2 }] });
    await gate.call(STEP, "system", { q: 1 }, schema);
    await gate.call(ANSWER, "system", { q: 2 }, schema);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate", "generate:1"]);
    expect(checked).toEqual(["2026-10-06T00:00:00.000Z", "2026-10-06T00:00:01.000Z"]);
    expect(gate.stats().calls).toBe(2);
  });

  it("asks for an incremental check before every call, repairs included", async () => {
    const modes: string[] = [];
    const { gate, trace } = harness({ replies: [{ bad: true }, { good: true }, { c: 3 }], modes });
    await gate.withRepair(STEP, "system", {}, schema, reply => {
      if ((reply as { bad?: boolean }).bad) throw new AgenticAskOutputErrorV1("needs are missing");
      return reply;
    });
    await gate.call(ANSWER, "system", {}, schema);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate", "generate:1", "revalidate", "generate:2"]);
    expect(modes).toEqual(["incremental", "incremental", "incremental"]);
  });

  it.each(["unavailable", "rate_limited"] as const)("retries a %s pre-call check once after a short pause", async code => {
    let checks = 0;
    const { gate, trace, checked } = harness({ replies: [{ a: 1 }], desk_revalidate: async () => {
      if (++checks === 1) throw new AuthorityOperationError(code, "Live evidence operation could not be completed");
      return { checked_at: "2026-10-06T00:00:01.000Z" };
    } });
    const started = Date.now();
    await expect(gate.call(STEP, "system", {}, schema)).resolves.toEqual({ a: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1 - 50);
    expect(trace).toEqual(["revalidate", "revalidate", "generate:0"]);
    expect(checked).toEqual(["2026-10-06T00:00:01.000Z"]);
  });

  it("fails the call when the retried pre-call check fails again", async () => {
    const { gate, trace } = harness({ desk_revalidate: async () => { throw new AuthorityOperationError("unavailable", "Live evidence operation could not be completed"); } });
    await expect(gate.call(STEP, "system", {}, schema)).rejects.toMatchObject({ code: "unavailable" });
    expect(trace).toEqual(["revalidate", "revalidate"]);
    expect(gate.stats().calls).toBe(0);
  });

  it.each(["unauthorized", "stale_access_state", "not_found", "invalid_output"] as const)("never retries a %s pre-call check", async code => {
    const { gate, trace } = harness({ desk_revalidate: async () => { throw new AuthorityOperationError(code, "Live evidence operation could not be completed"); } });
    await expect(gate.call(STEP, "system", {}, schema)).rejects.toMatchObject({ code });
    expect(trace).toEqual(["revalidate"]);
  });

  it('does not recheck an invalidated snapshot as a transient provider failure', async () => {
    const changed = new EvidenceDeskSnapshotChangedV1();
    const { gate, trace } = harness({ desk_revalidate: async () => { throw changed; } });
    await expect(gate.call(STEP, 'system', {}, schema)).rejects.toBe(changed);
    expect(trace.filter(value => value === 'revalidate')).toHaveLength(1);
    expect(gate.stats().calls).toBe(0);
  });

  it("does not retry a transient pre-call check once the request stops", async () => {
    const controller = new AbortController();
    const stopped = harness({ signal: controller.signal, desk_revalidate: async () => {
      setTimeout(() => controller.abort(), 10);
      throw new AuthorityOperationError("unavailable", "Live evidence operation could not be completed");
    } });
    await expect(stopped.gate.call(STEP, "system", {}, schema)).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.trace).toEqual(["revalidate"]);
  });

  it("counts no calls: a request may make as many as it needs", async () => {
    const { gate, trace } = harness({ replies: Array.from({ length: 100 }, (_value, index) => ({ a: index })) });
    for (let index = 0; index < 100; index += 1) await gate.call(STEP, "system", {}, schema);
    expect(trace.filter(entry => entry === "revalidate")).toHaveLength(100);
    expect(gate.stats()).toMatchObject({ calls: 100, stopped: false });
  });

  it.each(["honours", "ignores"] as const)("never sends again a call that went silent, whose billing is unknown, when the port %s its abort", async port => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const { gate, trace } = harness({ model: { generate: input => new Promise<never>((_resolve, reject) => {
        signals.push(input.signal!);
        if (port === "honours") input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      }) } });
      const pending = gate.withRepair(STEP, "system", {}, schema, value => value).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(generation.timeout_ms);
      const error = await pending;
      expect(error).toBeInstanceOf(AgenticModelStalledErrorV1);
      expect(error).toMatchObject({ message: "the model sent nothing for 30 s", recovery: "fallback" });
      // The gate's abort reached the operation, and nothing was sent again; the writer stays available.
      expect(signals.map(signal => signal.aborted)).toEqual([true]);
      expect(trace).toEqual(["revalidate"]);
      expect(gate.stats()).toMatchObject({ calls: 1, repairs: 0, stopped: false });
    } finally { vi.useRealTimers(); }
  });

  it("retries once a silence the adapter reports was never sent, then names the stall", async () => {
    const unsent = () => Object.assign(new Error("silent before sending"), { diagnostic: { failure_class: "adapter_timeout", http_status: null, finish_reason: null, unbilled: true } });
    const { gate, trace } = harness({ replies: [unsent(), unsent()] });
    await expect(gate.withRepair(STEP, "system", {}, schema, value => value)).rejects.toBeInstanceOf(AgenticModelStalledErrorV1);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate", "generate:1"]);
    expect(gate.stats()).toMatchObject({ calls: 2, repairs: 1, stopped: false });
  });

  it("never stops or repeats a call that keeps reporting progress past its silence period", async () => {
    vi.useFakeTimers();
    try {
      // A streaming writer sends a piece every second for three silence periods, then finishes.
      let aborted = false;
      const { gate, trace } = harness({ model: { generate: input => new Promise(resolve => {
        trace.push("generate");
        input.signal!.addEventListener("abort", () => { aborted = true; }, { once: true });
        let pieces = 0;
        const tick = setInterval(() => { input.on_progress!(); if (++pieces === 90) { clearInterval(tick); resolve({ ok: true }); } }, 1_000);
      }) } });
      const pending = gate.withRepair(ANSWER, "system", {}, schema, value => value);
      await vi.advanceTimersByTimeAsync(3 * generation.timeout_ms);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(aborted).toBe(false);
      expect(trace).toEqual(["revalidate", "generate"]);
      expect(gate.stats()).toMatchObject({ calls: 1, repairs: 0 });
    } finally { vi.useRealTimers(); }
  });

  it("lets a call that keeps working past any former clock finish", async () => {
    vi.useFakeTimers();
    try {
      // Each call returns inside its silence period; together they run far past what a run deadline once allowed.
      const { gate } = harness({ model: { generate: () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), generation.timeout_ms - 1)) } });
      for (let index = 0; index < 40; index += 1) {
        const pending = gate.call(STEP, "system", {}, schema);
        await vi.advanceTimersByTimeAsync(generation.timeout_ms - 1);
        await expect(pending).resolves.toEqual({ ok: true });
      }
      expect(gate.stats().calls).toBe(40);
    } finally { vi.useRealTimers(); }
  });

  it("stops after a permanent provider failure and still records the call", async () => {
    const permanent = Object.assign(new Error("denied"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } });
    const { gate } = harness({ replies: [permanent] });
    await expect(gate.call(ANSWER, "system", {}, schema)).rejects.toBeInstanceOf(AgenticAskOutputErrorV1);
    expect(gate.stats()).toMatchObject({ calls: 1, stopped: true, generations: [{ role: "answer", finish_reason: null, usage: null }] });
  });

  it.each(['length', 'content_filter'] as const)('captures one terminal response for a %s finish while preserving repair or fallback', async finish_reason => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const replies = [{ partial: true }, { good: true }];
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: null, reasoning_tokens: null };
    let calls = 0;
    const { gate } = harness({
      model: {
        generate: async () => { throw new Error('value-only method must not be used'); },
        generate_with_observation: async () => ({ value: replies[calls++], usage, provider_latency_ms: 1, finish_reason: calls === 1 ? finish_reason : 'stop' }),
      },
      desk_revalidate: async () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
    });
    const pending = withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => gate.withRepair(STEP, 'system', {}, schema, value => value));
    if (finish_reason === 'length') await expect(pending).resolves.toEqual({ good: true });
    else await expect(pending).rejects.toMatchObject({ recovery: 'fallback' });
    const requests = events.filter(event => event.kind === 'model_request');
    const terminals = events.filter(event => event.kind === 'model_response' || event.kind === 'model_error');
    expect(requests).toHaveLength(finish_reason === 'length' ? 2 : 1);
    // The exporter pairs each admitted call with exactly one terminal event.
    for (const request of requests) {
      expect(terminals.filter(event => event.call_id === request.call_id)).toEqual([
        expect.objectContaining({ kind: 'model_response', span_id: request.span_id, value: replies[request.call_id - 1], usage }),
      ]);
    }
    expect(terminals[0]).toMatchObject({ finish_reason });
    expect(gate.stats()).toMatchObject({ calls: requests.length, repairs: finish_reason === 'length' ? 1 : 0, stopped: finish_reason === 'content_filter' });
  });

  it('puts the serving host and generation id an adapter reports on the call\'s terminal event, served or failed', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: null, reasoning_tokens: null };
    const served = { upstream_provider: 'DeepInfra', generation_id: 'gen-1760650000-AbCdEfGh12345678' };
    const timeout = Object.assign(new Error('private provider text'), {
      diagnostic: { failure_class: 'adapter_timeout', http_status: null, finish_reason: null },
      generation_observation: { usage, provider_latency_ms: 7_000, upstream_provider: 'Friendli', generation_id: 'gen-1760650001-ZyXwVuTs98765432' },
    });
    let calls = 0;
    const { gate } = harness({
      model: {
        generate: async () => { throw new Error('value-only method must not be used'); },
        generate_with_observation: async () => {
          if (calls++ === 0) return { value: { a: 1 }, usage, provider_latency_ms: 1, finish_reason: 'stop', ...served };
          throw timeout;
        },
      },
    });
    await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, async () => {
      await gate.call(STEP, 'system', {}, schema);
      await expect(gate.call(STEP, 'system', {}, schema)).rejects.toBeInstanceOf(AgenticModelStalledErrorV1);
    });
    expect(events.filter(event => event.kind === 'model_response' || event.kind === 'model_error')).toEqual([
      expect.objectContaining({ kind: 'model_response', call_id: 1, ...served }),
      expect.objectContaining({ kind: 'model_error', call_id: 2, error_kind: 'adapter_timeout', upstream_provider: 'Friendli', generation_id: 'gen-1760650001-ZyXwVuTs98765432' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private provider text');
  });

  it("repairs once with the validation error and the rejected reply", async () => {
    const { gate, inputs } = harness({ replies: [{ bad: true }, { good: true }] });
    const rejections: string[] = [];
    const value = await gate.withRepair(STEP, "system", { question: "q" }, schema, reply => {
      if ((reply as { bad?: boolean }).bad) throw new AgenticAskOutputErrorV1("needs are missing");
      return reply;
    }, reason => rejections.push(reason));
    expect(value).toEqual({ good: true });
    expect(rejections).toEqual(["needs are missing"]);
    // The system prompt and the rejected call's user prompt are the repair's prefix; the reason goes last.
    expect(inputs[1]!.system_prompt).toBe("system");
    expect(inputs[1]!.user_prompt.startsWith(inputs[0]!.user_prompt.slice(0, -1))).toBe(true);
    expect(inputs[1]!.user_prompt).toBe(JSON.stringify({ question: "q", rejected_response: JSON.stringify({ bad: true }), validation_error: repairInstruction("needs are missing") }));
    expect(repairInstruction("needs are missing")).toBe("Your previous reply could not be used: needs are missing. Reply again with only the JSON object, in exactly the shape your instructions show.");
    expect(gate.stats()).toMatchObject({ calls: 2, repairs: 1, stopped: false });
  });

  it("sends a rejected reply back whole, as one clean line, however long it is", async () => {
    // A rejected reply of about 9,000 characters (a full writer reply), with a line separator and a double space.
    const refused = { blocks: [{ block: "text", sentences: [{ text: `Priya Raman owns it.\u2028Then  ${"more ".repeat(1_800)}end`, evidence: ["E1"] }] }], not_found: [] };
    const { gate, inputs } = harness({ replies: [refused, { good: true }] });
    await gate.withRepair(STEP, "system", { question: "q" }, schema, reply => {
      if ((reply as { good?: boolean }).good !== true) throw new AgenticAskOutputErrorV1("blocks[0] must be the answer block");
      return reply;
    }, () => undefined);
    expect(inputs[1]!.user_prompt).toBe(JSON.stringify(repairInput({ question: "q" }, refused, "blocks[0] must be the answer block")));
    const sent = (JSON.parse(inputs[1]!.user_prompt) as { readonly rejected_response: string }).rejected_response;
    // The whole reply, made one clean line: nothing of it is cut.
    expect(sent).toBe(cleanLine(JSON.stringify(refused), Number.POSITIVE_INFINITY));
    expect([sent.endsWith('"not_found":[]}'), sent.includes("\u2028"), sent.includes("  ")]).toEqual([true, false, false]);
    // A reply as long as the model's whole output is still shown whole: it already fit beside the prompt it answered.
    const huge = { text: "word ".repeat(100_000).trim() };
    const sentHuge = repairInput({}, huge, "x").rejected_response as string;
    expect([sentHuge, sentHuge.endsWith("…")]).toEqual([JSON.stringify(huge), false]);
  });

  describe("counts each retry and repair it makes, by why it was needed", () => {
    const failure = (failure_class: string, extra: Record<string, unknown> = {}) =>
      Object.assign(new Error("private provider text"), { diagnostic: { failure_class, http_status: null, finish_reason: null, ...extra } });
    /** The corrections the caller's span counted while the gate ran one call and its recovery. */
    const corrected = async (options: Parameters<typeof harness>[0]) => {
      const { gate } = harness(options);
      const events: CoreRuntimeObservationV1[] = [];
      await observeCoreRuntimeV1("research_loop", () => gate.withRepair(STEP, "system", {}, schema, reply => {
        if ((reply as { bad?: boolean }).bad) throw new AgenticAskOutputErrorV1("needs are missing");
        return reply;
      }), { observer: event => { events.push(event); } }).catch(() => undefined);
      return events.find(event => event.phase === "research_loop" && event.event !== "started")!.model_corrections ?? {};
    };

    it.each([
      ["a reply its caller rejects", [{ bad: true }, { good: true }], { model_repair_rejected: 1 }],
      ["a reply that is not JSON", [failure("adapter_json"), { good: true }], { model_repair_json: 1 }],
      ["a reply with no usable content", [failure("adapter_response", { http_status: 200 }), { good: true }], { model_repair_empty: 1 }],
      ["a reply cut off at its length", [failure("adapter_finish", { finish_reason: "length" }), { good: true }], { model_repair_unfinished: 1 }],
      ["a provider timeout before the request was sent", [failure("adapter_timeout", { unbilled: true }), { good: true }], { model_retry: 1 }],
      ["a provider timeout after the request may have been accepted, which is never repeated", [failure("adapter_timeout"), { good: true }], {}],
      ["a temporary provider error", [failure("adapter_http", { http_status: 503 }), { good: true }], { model_retry: 1 }],
      ["a repair whose reply is rejected again", [{ bad: true }, { bad: true }], { model_repair_rejected: 1 }],
      ["a permanent provider error, which is never repaired", [failure("adapter_http", { http_status: 401 })], {}],
      ["a declined reply, which is never repaired", [failure("adapter_refusal")], {}],
      ["a usable reply", [{ good: true }], {}],
      // A stream cut part way through an event, after a 200: the reply never arrived whole, so it is neither repaired nor,
      // its billing unknown, sent again.
      ["a stream cut mid-event, which is never repaired or repeated", [failure("adapter_transport", { http_status: 200 }), { good: true }], {}],
    ])("for %s", async (_name, replies, expected) => {
      expect(await corrected({ replies })).toEqual(expected);
    });

    // A repair is admitted only for a reply that arrived whole and failed validation, and it carries the rejected reply.
    it.each([
      ["not JSON", failure("adapter_json"), "repair"],
      ["with no usable content", failure("adapter_response", { http_status: 200 }), "repair"],
      ["cut off at its length", failure("adapter_finish", { finish_reason: "length" }), "repair"],
      ["cut mid-event (a transport loss)", failure("adapter_transport", { http_status: 200 }), "none"],
      ["cut mid-event, a transport loss the adapter calls unbilled", failure("adapter_transport", { http_status: 200, unbilled: true }), "unchanged"],
    ] as const)("repairs a reply %s only when it arrived whole", async (_name, error, next) => {
      const { gate, inputs } = harness({ replies: [error, { good: true }] });
      await gate.withRepair(STEP, "system", { q: 1 }, schema, value => value).catch(() => undefined);
      const second = inputs[1];
      // A repair sends guidance with the reply; a transport loss is at most sent again unchanged, never repaired.
      expect(second === undefined ? "none" : second.user_prompt === inputs[0]!.user_prompt ? "unchanged" : "repair").toBe(next);
      expect(gate.stats().repairs).toBe(second === undefined ? 0 : 1);
    });

    // A paid attempt is never repeated automatically: only a failure known to be unbilled earns the one retry.
    it.each([
      ["a refusal before the request was fully sent", failure("adapter_transport", { unbilled: true }), true],
      ...[429, 503, 529].map(status => [`an explicit ${status} refusal`, failure("adapter_http", { http_status: status }), true] as const),
      ["a transport failure after the request may have been accepted (a stream with no finish reason)", failure("adapter_transport"), false],
      ...[500, 502, 504].map(status => [`a ${status} failure`, failure("adapter_http", { http_status: status }), false] as const),
      ["a provider error inside a 200 reply", failure("adapter_provider_error", { http_status: 200 }), false],
      ["a provider error with no status", failure("adapter_provider_error"), false],
      ["a finish reason of error", failure("adapter_finish", { finish_reason: "error" }), false],
    ] as const)("sends %s again only when it is unbilled", async (_name, error, retried) => {
      const { gate, trace } = harness({ replies: [error, { good: true }] });
      const outcome = await gate.withRepair(STEP, "system", {}, schema, value => value).catch((thrown: unknown) => thrown);
      expect(trace.filter(entry => entry.startsWith("generate"))).toHaveLength(retried ? 2 : 1);
      if (retried) expect(outcome).toEqual({ good: true });
      // A failure whose billing is unknown names its own reason and stops only its own call: the writer stays available.
      else expect([outcome instanceof AgenticModelUnsettledErrorV1, (outcome as Error).message === "private provider text", gate.stats().stopped]).toEqual([true, false, false]);
    });

    it("counts a reply an observing adapter reports cut off", async () => {
      const replies = [{ partial: true }, { good: true }];
      const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: null, reasoning_tokens: null };
      let calls = 0;
      expect(await corrected({ model: {
        generate: async () => { throw new Error("value-only method must not be used"); },
        generate_with_observation: async () => ({ value: replies[calls], usage, provider_latency_ms: 1, finish_reason: calls++ === 0 ? "length" : "stop" }),
      } })).toEqual({ model_repair_unfinished: 1 });
    });

  });

  it("fingerprints every admitted call exactly as the Ask audit does", async () => {
    const { gate, inputs } = harness({ replies: [{ a: 1 }] });
    await gate.call(STEP, "system", { q: 1 }, schema);
    const input = inputs[0]!;
    // Every call's allowance is the model's own maximum output, from the profile.
    expect(input.max_output_tokens).toBe(generation.max_output_tokens);
    expect(gate.stats().invocation_digests).toEqual([canonicalSha256({
      role: "step", model: input.model, system_prompt: input.system_prompt, user_prompt: input.user_prompt,
      schema: input.schema, max_output_tokens: input.max_output_tokens, timeout_ms: input.timeout_ms,
    })]);
  });

  it("runs each call in the span its caller names, while the audit records the role", async () => {
    const { gate } = harness({ replies: [{ a: 1 }, { b: 2 }] });
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("ask_request", async () => {
      await gate.call({ role: "step", span: "ask_answer" }, "system", {}, schema);
      await gate.call({ role: "answer", span: "ask_planner" }, "system", {}, schema);
    }, { observer: event => { events.push(event); } });
    expect(events.filter(event => !event.root && event.event === "started").map(event => event.stage)).toEqual(["research_revalidation", "ask_answer", "research_revalidation", "ask_planner"]);
    expect(gate.stats().generations.map(entry => entry.role)).toEqual(["step", "answer"]);
  });

  it("refuses an operation started after the abort without leaving its rejection unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.once("unhandledRejection", record);
    try {
      const controller = new AbortController();
      controller.abort();
      let reject!: (reason: Error) => void;
      const late = new Promise<never>((_resolve, rejectLate) => { reject = rejectLate; });
      await expect(raceAbort(controller.signal, late)).rejects.toMatchObject({ name: "AbortError" });
      reject(new Error("late desk failure"));
      // Give an unhandled rejection a macrotask to surface.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", record); }
  });
});
