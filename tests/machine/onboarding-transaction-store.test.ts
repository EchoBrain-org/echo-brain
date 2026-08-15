import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOnboardingTransaction,
  deriveOnboardingIdentity,
  finishOnboardingTransaction,
  parseOnboardingReceipt,
  transitionOnboardingStep,
} from '../../src/product/onboarding/onboarding-transaction.js';
import { FileOnboardingTransactionStore } from '../../src/product/onboarding/onboarding-transaction-store.js';

const NOW = '2026-08-15T12:00:00.000Z';
const LATER = '2026-08-15T12:30:00.000Z';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-onboarding-store-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(root: string) {
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const store = new FileOnboardingTransactionStore({
    directory: join(root, 'onboarding'),
    stateDir,
  });
  const transaction = createOnboardingTransaction({
    identity: deriveOnboardingIdentity({
      authorityId: 'auth_1',
      organizationId: 'org_1',
      membershipId: 'mem_1',
      invitationCommandId: 'adm_1',
      enrollmentGrantSha256: `sha256:${'a'.repeat(64)}`,
    }),
    configPath: join(root, 'config.json'),
    stateDirectory: stateDir,
    now: NOW,
  });
  return { store, transaction, stateDir };
}

describe('FileOnboardingTransactionStore', () => {
  it('returns null before any transaction is saved and round-trips a save', async () => {
    const { store, transaction } = fixture(temporaryRoot());
    expect(await store.loadActive()).toBeNull();
    await store.saveActive(transaction);
    expect(await store.loadActive()).toEqual(transaction);
  });

  it('persists the transaction as a private mode-0600 file', async () => {
    const root = temporaryRoot();
    const { store, transaction } = fixture(root);
    await store.saveActive(transaction);
    const path = join(root, 'onboarding', 'active-transaction.v1.json');
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a store directory inside the product state directory', () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    expect(
      () =>
        new FileOnboardingTransactionStore({
          directory: join(stateDir, 'onboarding'),
          stateDir,
        }),
    ).toThrow(/state/u);
  });

  it('rejects a tampered on-disk transaction', async () => {
    const root = temporaryRoot();
    const { store, transaction } = fixture(root);
    await store.saveActive(transaction);
    const path = join(root, 'onboarding', 'active-transaction.v1.json');
    const tampered = JSON.parse(readFileSync(path, 'utf8'));
    tampered.next_steps = ['echo-brain doctor'];
    writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`, {
      mode: 0o600,
    });
    await expect(store.loadActive()).rejects.toThrow(/unknown or missing/u);
  });

  it('stores the final receipt write-once and tolerates an identical replay', async () => {
    const root = temporaryRoot();
    const { store, transaction } = fixture(root);
    let finished = transaction;
    finished = transitionOnboardingStep(finished, 'classify', {
      to: 'terminal_preserved',
      now: LATER,
    });
    const { transaction: terminal, receipt } = finishOnboardingTransaction(
      finished,
      'preserved',
      'ambiguous_installation',
      LATER,
    );
    await store.saveActive(terminal);
    await store.saveReceipt(receipt);
    await store.saveReceipt(receipt);
    const conflicting = { ...receipt, result: 'ready' };
    await expect(
      store.saveReceipt(parseOnboardingReceipt(conflicting)),
    ).rejects.toThrow(/immutable/u);
  });
});
