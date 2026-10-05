import { describe, expect, it, vi } from 'vitest';
import { abortableProviderOperationV1, BoundedJsonResponseErrorV1, disposeProviderResponseV1, readBoundedJsonResponseV1 } from '../src/bounded-json-response-v1.js';

const options = () => ({ maxBytes: 32, signal: new AbortController().signal });
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('shared provider JSON response boundary', () => {
  it('preserves distinct declared-length policies without relaxing the streamed byte cap', async () => {
    const response = () => new Response('{}', { headers: { 'content-length': '002' } });
    expect(await readBoundedJsonResponseV1(response(), options())).toEqual({});
    await expect(readBoundedJsonResponseV1(response(), { ...options(), contentLength: 'canonical' })).rejects.toMatchObject({ code: 'oversized' });
    expect(await readBoundedJsonResponseV1(new Response('{}', { headers: { 'content-length': 'not-a-length' } }), { ...options(), contentLength: 'ignore' })).toEqual({});
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(33)); }, cancel,
    });
    await expect(readBoundedJsonResponseV1(new Response(stream), { ...options(), contentLength: 'ignore' })).rejects.toMatchObject({ code: 'oversized' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lets only the selected caller accept null and empty bodies', async () => {
    for (const body of [null, '']) {
      expect(await readBoundedJsonResponseV1(new Response(body), { ...options(), emptyBody: 'undefined' })).toBeUndefined();
      await expect(readBoundedJsonResponseV1(new Response(body), options())).rejects.toMatchObject({ code: 'invalid_json' });
    }
  });

  it('sanitizes malformed UTF-8, JSON and stream errors', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private provider detail')); } });
    for (const response of [new Response(new Uint8Array([0xc3, 0x28])), new Response('private provider detail'), new Response(stream)]) {
      const error: unknown = await readBoundedJsonResponseV1(response, options()).catch(value => value);
      expect(error).toBeInstanceOf(BoundedJsonResponseErrorV1);
      expect((error as Error).message).not.toContain('private');
    }
  });

  it('does not start an operation when already cancelled and disposes a late response', async () => {
    const stopped = new AbortController(); stopped.abort();
    const operation = vi.fn(async () => new Response('{}'));
    expect(() => abortableProviderOperationV1(operation, stopped.signal)).toThrow();
    expect(operation).not.toHaveBeenCalled();
    const controller = new AbortController();
    const late = deferred<Response>();
    const pending = abortableProviderOperationV1(() => late.promise, controller.signal, disposeProviderResponseV1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const cancel = vi.fn();
    late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled body without awaiting a stalled cleanup', async () => {
    const controller = new AbortController();
    const reading = deferred<void>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined); }, cancel }, { highWaterMark: 0 }));
    const pending = readBoundedJsonResponseV1(response, { ...options(), signal: controller.signal });
    await reading.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
});
