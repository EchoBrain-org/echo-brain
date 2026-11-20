import { createHash } from 'node:crypto';
import type { StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { ClaudeAccountProfileV1 } from './account-profile.js';
import { ClaudeResearchResultErrorV1, runClaudeStructuredV1 } from './sdk-client.js';
import { claudeAccountForwarderV1, claudeModelFailureUnbilledV1, ClaudeModelRepeatRefusedErrorV1, ClaudeModelResponseErrorV1, ClaudeModelTransportErrorV1, startClaudeModelTransportV1, type ClaudeModelForwarderV1 } from './model-transport.js';

export class ClaudeSingleGenerationLimitErrorV1 extends Error {
  constructor() { super('Native extraction permits a single generation'); }
}

/** The native client owns sign-in. ECHO admits every outbound request and validates the returned answer. */
export function createClaudeAccountStructuredGenerationV1(options: {
  readonly account: ClaudeAccountProfileV1;
  readonly model: string;
  readonly forward?: ClaudeModelForwarderV1;
  readonly run?: typeof runClaudeStructuredV1;
  /** An extraction attempt cannot hide SDK retries, repairs or auxiliary model requests. */
  readonly max_model_requests?: 1;
}): StructuredGenerationPort {
  return {
    async generate() { throw new Error('Native structured generation requires per-request admission'); },
    async generate_with_admission(input, admit) {
      if (input.model !== options.model) throw new Error('Unexpected native writer model');
      // Claude Code's max_tokens holds thinking and the answer together; the caller's allowance is the model's own maximum.
      const allowance = input.max_output_tokens;
      // `timeout_ms` is a silence period, not a whole-session clock: the SDK streams each model reply through the local
      // transport, and every piece of model output in it resets it (and is reported to the caller as `on_progress`).
      // A session whose model produces nothing for it is stalled.
      const stop = new AbortController();
      const silence = new AbortController();
      const timeout = silence.signal;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      const alive = (): void => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => silence.abort(new DOMException('The native session sent nothing for the silence period', 'TimeoutError')), input.timeout_ms);
      };
      const produced = (): void => { alive(); input.on_progress?.(); };
      alive();
      const signal = AbortSignal.any([...(input.signal === undefined ? [] : [input.signal]), stop.signal, timeout]);
      let terminal: unknown;
      let providerFailure: unknown;
      let messages = 0;
      // A generation whose billing is unknown is never repeated by the SDK: its retry is refused before admission.
      let billingUnknown = false;
      const fence = await startClaudeModelTransportV1({ signal, alive: produced, forward: options.forward ?? claudeAccountForwarderV1(options.model),
        admit: async (body, operation, forward) => {
          try {
            if (billingUnknown && operation === 'messages') throw new ClaudeModelRepeatRefusedErrorV1();
            // Claim before awaiting admission, so concurrent SDK requests cannot share one attempt.
            if (options.max_model_requests === 1 && (operation !== 'messages' || messages++ !== 0)) {
              throw new ClaudeSingleGenerationLimitErrorV1();
            }
            const payload = JSON.parse(body.toString('utf8'));
            if (payload.model !== input.model) throw new Error('Unexpected native writer model');
            if (operation === 'messages' && (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens <= 0 || payload.max_tokens > allowance)) throw new Error('Native writer exceeded its output allowance');
            const strings: string[] = [];
            const collect = (value: unknown): void => {
              if (typeof value === 'string') strings.push(value);
              else if (Array.isArray(value)) value.forEach(collect);
              else if (value && typeof value === 'object') Object.values(value).forEach(collect);
            };
            collect(payload);
            // Native framing may surround these strings; it must preserve the exact admitted writer inputs.
            if (![input.system_prompt, input.user_prompt].every(text => strings.some(value => value.includes(text)))) throw new Error('Native writer changed its evidence input');
            return await admit({ model: input.model, body_sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`, operation,
              signal,
              ...(operation === 'messages' ? { diagnostic_input: { model: input.model, system_prompt: JSON.stringify(payload.system ?? []),
                user_prompt: JSON.stringify(payload.messages ?? []), schema: { tools: payload.tools ?? [] }, max_output_tokens: payload.max_tokens ?? 0,
                timeout_ms: input.timeout_ms } } : {}),
            }, async (admittedSignal: AbortSignal, progress?: () => void) => {
              const result = await forward(admittedSignal, progress);
              providerFailure = undefined;
              return { ...result, value: result.content ?? null };
            });
          } catch (error) {
            if (error instanceof ClaudeModelResponseErrorV1 || error instanceof ClaudeModelTransportErrorV1) {
              providerFailure = error;
              if (operation === 'messages' && !claudeModelFailureUnbilledV1(error)) billingUnknown = true;
            } else if (error instanceof ClaudeModelRepeatRefusedErrorV1) stop.abort(error);
            else { terminal ??= error; stop.abort(error); }
            throw error;
          }
        },
      });
      try {
        const value = await (options.run ?? runClaudeStructuredV1)({ prompt: input.user_prompt, system: input.system_prompt, schema: input.schema,
          model: input.model, max_output_tokens: allowance, base_url: fence.base_url, account: options.account, signal,
          ...(options.max_model_requests === 1 ? { single_generation: true } : {}) });
        if (terminal !== undefined) throw terminal;
        if (fence.forwarded() === 0) throw new Error('Native writer did not use model admission');
        return value;
      } catch (error) {
        input.signal?.throwIfAborted();
        const timedOut = timeout.aborted && signal.reason === timeout.reason;
        if (terminal !== undefined && !timedOut) throw terminal;
        if (providerFailure !== undefined && !timedOut) throw providerFailure;
        if (timedOut) throw Object.assign(new Error('Native writer unavailable'), { diagnostic: { failure_class: 'adapter_timeout', http_status: null, finish_reason: null } });
        if (error instanceof ClaudeResearchResultErrorV1) {
          // A reply stopped at its output allowance did not finish: the gate repairs it as it would OpenRouter's. The SDK's
          // result subtype and stop reason are content-free and travel with the failure.
          const unfinished = error.stop_reason === 'max_tokens';
          throw Object.assign(new Error(`Native writer unavailable (${error.subtype})`), { diagnostic: {
            failure_class: unfinished ? 'adapter_finish' : 'adapter_response', http_status: 200, finish_reason: unfinished ? 'length' : null,
            sdk_subtype: error.subtype, sdk_stop_reason: error.stop_reason,
          } });
        }
        throw error;
      } finally { clearTimeout(silenceTimer); stop.abort(); fence.close(); }
    },
  };
}
