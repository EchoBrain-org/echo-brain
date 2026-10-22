import { createHash } from 'node:crypto';
import type { StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { ClaudeAccountProfileV1 } from './account-profile.js';
import { ClaudeResearchResultErrorV1, runClaudeStructuredV1 } from './sdk-client.js';
import { claudeAccountForwarderV1, ClaudeModelResponseErrorV1, ClaudeModelTransportErrorV1, startClaudeModelTransportV1, type ClaudeModelForwarderV1 } from './model-transport.js';

/** The native client owns sign-in. ECHO admits every outbound request and validates the returned answer. */
export function createClaudeAccountStructuredGenerationV1(options: {
  readonly account: ClaudeAccountProfileV1;
  readonly model: string;
  readonly forward?: ClaudeModelForwarderV1;
  readonly run?: typeof runClaudeStructuredV1;
}): StructuredGenerationPort {
  return {
    async generate() { throw new Error('Native structured generation requires per-request admission'); },
    async generate_with_admission(input, admit) {
      if (input.model !== options.model) throw new Error('Unexpected native writer model');
      const stop = new AbortController();
      const timeout = AbortSignal.timeout(input.timeout_ms);
      const signal = AbortSignal.any([...(input.signal === undefined ? [] : [input.signal]), stop.signal, timeout]);
      const deadline = performance.now() + input.timeout_ms;
      let terminal: unknown;
      let providerFailure: unknown;
      const fence = await startClaudeModelTransportV1({ signal, forward: options.forward ?? claudeAccountForwarderV1(options.model),
        admit: async (body, operation, forward) => {
          try {
            const payload = JSON.parse(body.toString('utf8'));
            if (payload.model !== input.model) throw new Error('Unexpected native writer model');
            if (operation === 'messages' && (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens <= 0 || payload.max_tokens > input.max_output_tokens)) throw new Error('Native writer exceeded its output allowance');
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
              timeout: () => deadline - performance.now(), signal,
              ...(operation === 'messages' ? { diagnostic_input: { model: input.model, system_prompt: JSON.stringify(payload.system ?? []),
                user_prompt: JSON.stringify(payload.messages ?? []), schema: { tools: payload.tools ?? [] }, max_output_tokens: payload.max_tokens ?? 0,
                timeout_ms: Math.max(1, Math.floor(deadline - performance.now())) } } : {}),
            }, async admittedSignal => {
              const result = await forward(admittedSignal);
              providerFailure = undefined;
              return { ...result, value: result.content ?? null };
            });
          } catch (error) {
            if (error instanceof ClaudeModelResponseErrorV1 || error instanceof ClaudeModelTransportErrorV1) providerFailure = error;
            else { terminal ??= error; stop.abort(error); }
            throw error;
          }
        },
      });
      try {
        const value = await (options.run ?? runClaudeStructuredV1)({ prompt: input.user_prompt, system: input.system_prompt, schema: input.schema,
          model: input.model, max_output_tokens: input.max_output_tokens, base_url: fence.base_url, account: options.account, signal });
        if (terminal !== undefined) throw terminal;
        if (fence.forwarded() === 0) throw new Error('Native writer did not use model admission');
        return value;
      } catch (error) {
        input.signal?.throwIfAborted();
        const timedOut = timeout.aborted && signal.reason === timeout.reason;
        if (terminal !== undefined && !timedOut) throw terminal;
        if (providerFailure !== undefined && !timedOut) throw providerFailure;
        if (timedOut || error instanceof ClaudeResearchResultErrorV1) {
          throw Object.assign(new Error('Native writer unavailable'), { diagnostic: {
            failure_class: timedOut ? 'adapter_timeout' : 'adapter_response', http_status: timedOut ? null : 200, finish_reason: null,
          } });
        }
        throw error;
      } finally { stop.abort(); fence.close(); }
    },
  };
}
