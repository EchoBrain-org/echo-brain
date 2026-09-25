import type { EventName, Events, MethodName, Methods, Result } from '../shared/protocol.js';

interface Bridge {
  rpc(method: string, params?: unknown): Promise<Result<unknown>>;
  on(name: string, listener: (payload: unknown) => void): () => void;
}

const bridge = (window as unknown as { echo: Bridge }).echo;

export function rpc<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Result<Methods[M]['result']>> {
  return bridge.rpc(method, params) as Promise<Result<Methods[M]['result']>>;
}

export function on<N extends EventName>(name: N, listener: (payload: Events[N]) => void): () => void {
  return bridge.on(name, listener as (payload: unknown) => void);
}
