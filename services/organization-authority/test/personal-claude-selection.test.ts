import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readPersonalClaudeAllModelsSelectionV1, readPersonalClaudeSelectionV1 } from '../src/composition/personal-claude-selection-v1.js';

const roots: string[] = [];
const origin = 'https://authority-staging.echobrain.org';
const value = { kind: 'echo-personal-claude-research-v1', membership_id: 'mem_owner' };
function selection(body: unknown = value) {
  const root = mkdtempSync(join(tmpdir(), 'echo-personal-selection-')); roots.push(root);
  const path = join(root, 'selection.json');
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('leaves hosts without a selection unchanged and fixes the native executable and sibling home', () => {
  expect(readPersonalClaudeSelectionV1(undefined, origin)).toBeUndefined();
  expect(readPersonalClaudeSelectionV1('/missing/personal-selection', 'https://authority.example')).toBeUndefined();
  const path = selection();
  expect(readPersonalClaudeSelectionV1(path, origin)).toEqual({ membership_id: 'mem_owner',
    executable_path: '/usr/local/bin/echo-claude-native', home_directory: join(path, '../claude-account') });
});

it.each([null, [], {}, { ...value, membership_id: 'owner@example.com' }, { ...value, membership_id: {} },
  { ...value, executable_path: '/tmp/other' }, { ...value, token: 'private-sentinel-never-print' }])('refuses invalid or credential-bearing selections without their contents', body => {
  expect(() => readPersonalClaudeSelectionV1(selection(body), origin)).toThrow(/^Hosted personal Claude selection is invalid$/);
});

it('refuses production, public files, and symlinks rather than silently changing the payer', () => {
  const path = selection();
  expect(() => readPersonalClaudeSelectionV1(path, 'https://authority.example')).toThrow('Hosted personal Claude selection is invalid');
  chmodSync(path, 0o644);
  expect(() => readPersonalClaudeSelectionV1(path, origin)).toThrow('Hosted personal Claude selection is invalid');
  chmodSync(path, 0o600);
  const link = `${path}.link`; symlinkSync(path, link);
  expect(() => readPersonalClaudeSelectionV1(link, origin)).toThrow('Hosted personal Claude selection is invalid');
});

const allModels = { kind: 'echo-personal-claude-all-models-v1', payer_membership_id: 'mem_owner', enabled: true };
function allSelection(body: unknown = allModels) {
  const memberPath = selection();
  const path = join(memberPath, '../personal-claude-all-models.json');
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return { memberPath, path };
}

it('requires separate consent and retains disabled adoption without widening the member-only selection', () => {
  const memberPath = selection();
  expect(readPersonalClaudeAllModelsSelectionV1(undefined, origin)).toBeUndefined();
  expect(readPersonalClaudeAllModelsSelectionV1(memberPath, origin)).toBeUndefined();
  const all = allSelection();
  expect(readPersonalClaudeAllModelsSelectionV1(all.memberPath, origin)).toEqual({ enabled: true, payer_membership_id: 'mem_owner',
    home_directory: join(all.path, '../claude-account'), executable_path: '/usr/local/bin/echo-claude-native' });
  expect(readPersonalClaudeSelectionV1(all.memberPath, origin)?.membership_id).toBe('mem_owner');
  writeFileSync(all.path, JSON.stringify({ ...allModels, enabled: false }));
  expect(readPersonalClaudeAllModelsSelectionV1(all.memberPath, origin)?.enabled).toBe(false);
});

it.each([null, [], {}, { ...allModels, enabled: 'true' }, { ...allModels, payer_membership_id: 'owner@example.com' },
  { ...allModels, executable_path: '/tmp/other' }, { ...allModels, token: 'private-sentinel-never-print' }])('refuses malformed all-models consent without exposing its contents', body => {
  const { memberPath } = allSelection(body);
  expect(() => readPersonalClaudeAllModelsSelectionV1(memberPath, origin)).toThrow(/^Hosted personal Claude all-models selection is invalid$/);
});

it('refuses unsafe all-models files and non-staging use even when the retained selection is disabled', () => {
  const { memberPath, path } = allSelection({ ...allModels, enabled: false });
  expect(() => readPersonalClaudeAllModelsSelectionV1(memberPath, 'https://authority.example')).toThrow('Hosted personal Claude all-models selection is invalid');
  chmodSync(path, 0o644);
  expect(() => readPersonalClaudeAllModelsSelectionV1(memberPath, origin)).toThrow('Hosted personal Claude all-models selection is invalid');
  rmSync(path); symlinkSync(memberPath, path);
  expect(() => readPersonalClaudeAllModelsSelectionV1(memberPath, origin)).toThrow('Hosted personal Claude all-models selection is invalid');
});
