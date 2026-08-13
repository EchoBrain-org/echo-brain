import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProductLifecycleLock,
  canonicalProductConfigSha256,
  productLifecycleLockPath,
} from '../../src/product/lifecycle-lock.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';

const roots: string[] = [];

function stateRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-lifecycle-lock-')),
  );
  roots.push(root);
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  return state;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('product lifecycle locks', () => {
  it('excludes a second runtime and keeps coordination outside state', async () => {
    const state = stateRoot();
    const lockPath = productLifecycleLockPath(state, 'runtime');
    expect(lockPath.startsWith(`${state}/`)).toBe(false);

    const release = await acquireProductLifecycleLock(state, 'runtime');
    expect(existsSync(lockPath)).toBe(true);
    await expect(
      acquireProductLifecycleLock(state, 'runtime', { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: 'busy' });
    await release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('uses independent runtime and maintenance leases in a fixed window', async () => {
    const state = stateRoot();
    const releaseRuntime = await acquireProductLifecycleLock(state, 'runtime');
    const releaseMaintenance = await acquireProductLifecycleLock(
      state,
      'maintenance',
    );
    await releaseMaintenance();
    await releaseRuntime();
  });

  it('serializes service mutations without contending with the daemon runtime lease', async () => {
    const state = stateRoot();
    const releaseRuntime = await acquireProductLifecycleLock(state, 'runtime');
    const releaseService = await acquireProductLifecycleLock(state, 'service');
    await expect(
      acquireProductLifecycleLock(state, 'service', { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: 'busy' });
    await releaseService();
    await releaseRuntime();
  });

  it('rejects coordination under a shared writable parent', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-lifecycle-parent-')),
    );
    roots.push(root);
    const shared = join(root, 'shared');
    mkdirSync(shared, { mode: 0o777 });
    chmodSync(shared, 0o777);
    await expect(
      acquireProductLifecycleLock(join(shared, 'state'), 'runtime'),
    ).rejects.toThrow(/must not be group- or world-writable/);
  });

  it('hashes equivalent validated config objects canonically', () => {
    const state = stateRoot();
    const base = {
      schema_version: 1,
      lane: 'team-product',
      state_dir: state,
      meeting_sources: [
        {
          adapter_id: 'granola',
          instance_id: 'primary',
          settings: { page_size: 30, cursor_overlap_ms: 1_000 },
        },
      ],
      decision_processor: {
        adapter_id: 'structured-text',
        instance_id: 'primary',
        settings: {},
      },
      delivery_surfaces: [
        {
          adapter_id: 'jsonl-outbox',
          instance_id: 'local',
          settings: {
            destination_id: 'local',
            path: join(state, 'outbox.jsonl'),
          },
        },
      ],
      approval_mode: 'manual',
    } as const;
    const reordered = {
      approval_mode: base.approval_mode,
      delivery_surfaces: base.delivery_surfaces,
      decision_processor: base.decision_processor,
      meeting_sources: base.meeting_sources,
      state_dir: base.state_dir,
      lane: base.lane,
      schema_version: base.schema_version,
    };
    expect(
      canonicalProductConfigSha256(validateProductRuntimeConfig(base)),
    ).toBe(
      canonicalProductConfigSha256(validateProductRuntimeConfig(reordered)),
    );
  });
});
