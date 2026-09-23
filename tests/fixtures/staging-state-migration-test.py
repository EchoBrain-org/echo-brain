"""Stopped-state filesystem proof using the actual installed wrapper helper."""
import contextlib
import io
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

source = pathlib.Path(sys.argv[1]).read_text()
helper = re.search(r"<<'ECHO_STATE_MIGRATION_PY'\n(.*?)^ECHO_STATE_MIGRATION_PY$", source, re.M | re.S).group(1)
sys.argv = [sys.argv[0]]

class StateMigration(unittest.TestCase):
    migration = 'v5-to-v6'
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='echo-state-migration-')
        self.root = pathlib.Path(self.temp.name).resolve()
        self.state, self.release = self.root / 'state', self.root / 'release'
        self.state.mkdir(mode=0o700); self.release.mkdir(mode=0o700)
        self.accepted, self.candidate = self.release / 'current.clean-v1.json', self.release / 'candidate.clean-v1.json'
        self.write(self.accepted, b'{"release_id":"clean-v1-old-fixture"}\n')
        self.write(self.candidate, b'{"release_id":"clean-v1-new-fixture"}\n')
        for name in ('authority.sqlite', 'authority.sqlite-wal', 'authority.sqlite-shm', 'control.sqlite', 'records.sqlite', 'facts.sqlite', 'lexical.sqlite', 'content.sqlite', 'state-lineage-root.v2.json'):
            self.write(self.state / name, (name + ': synthetic original\n').encode())
        (self.state / 'keys').mkdir(mode=0o700)
        self.write(self.state / 'keys/identity', b'synthetic identity retained\n')
        self.before = self.snapshot(self.state)
        self.inode = self.state.stat().st_ino
        self.operation = self.release / ('state-' + self.migration) / 'clean-v1-new-fixture'
        self.next = self.operation / 'next-state'
        self.backup, self.failed = self.operation / 'accepted-state', self.operation / 'failed-state'

    def tearDown(self): self.temp.cleanup()

    def write(self, path, value):
        path.write_bytes(value); path.chmod(0o600)

    def snapshot(self, path):
        return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*') if p.is_file()}

    def run_helper(self, action, fail_move=None, relative=False):
        output, previous = io.StringIO(), os.getcwd()
        args = ['migration', action, str(self.state), '.' if relative else str(self.release), str(self.accepted), str(self.candidate), f'{os.getuid()}:{os.getgid()}', self.migration]
        real_rename, moves = os.rename, 0
        def rename(a, b):
            nonlocal moves
            real_rename(a, b); moves += 1
            if moves == fail_move: raise OSError('simulated power-loss window')
        try:
            if relative: os.chdir(self.release)
            with patch.object(sys, 'argv', args), patch.object(os, 'rename', rename), contextlib.redirect_stdout(output):
                try: exec(compile(helper, '<installed-migration-helper>', 'exec'), {})
                except SystemExit as result:
                    return result.code in (None, 0), output.getvalue()
            return True, output.getvalue()
        finally: os.chdir(previous)

    def ok(self, action, **kwargs):
        result = self.run_helper(action, **kwargs)
        self.assertTrue(result[0], (action, result))
        return result[1]

    def converted(self):
        self.ok('prepare')
        self.write(self.next / 'authority.sqlite', b'converted candidate database')

    def test_unknown_transition_is_refused_without_changing_state(self):
        self.migration = 'v7-to-v9'
        self.assertFalse(self.run_helper('prepare')[0])
        self.assertFalse(self.operation.exists())
        self.assertEqual(self.snapshot(self.state), self.before)

    def test_copy_retains_all_roles_keys_and_sidecars_without_touching_source(self):
        self.ok('prepare', relative=True)
        self.assertEqual(self.snapshot(self.state), self.before)
        expected = {k: v for k, v in self.before.items() if not k.startswith('authority.sqlite')}
        self.assertEqual(self.snapshot(self.next), expected)
        self.assertFalse(self.run_helper('prepare')[0])
        self.ok('restore'); self.ok('complete')
        self.assertEqual(self.state.stat().st_ino, self.inode)
        self.assertEqual(self.snapshot(self.state), self.before)

    def test_partial_copy_failure_leaves_original_recoverable(self):
        with patch.object(shutil, 'copyfileobj', side_effect=OSError('injected copy failure')):
            self.assertFalse(self.run_helper('prepare')[0])
        self.assertEqual(self.snapshot(self.state), self.before)
        self.ok('restore'); self.ok('complete')
        self.assertEqual(self.snapshot(self.state), self.before)
        self.assertTrue(self.failed.exists())

    def test_rollback_retains_candidate_writes_and_is_repeatable(self):
        self.converted(); self.ok('cutover'); self.ok('ready'); self.ok('check')
        self.assertEqual(self.snapshot(self.backup), self.before)
        self.write(self.state / 'new-person-upload', b'synthetic canary upload')
        candidate = self.snapshot(self.state)
        self.ok('restore'); self.ok('complete')
        self.assertEqual(self.snapshot(self.state), self.before)
        self.assertEqual(self.snapshot(self.failed), candidate)
        self.ok('restore'); self.ok('complete')
        self.assertFalse(self.run_helper('check')[0])

    def test_each_cutover_rename_window_is_recoverable(self):
        for move in (1, 2):
            with self.subTest(move=move):
                self.converted()
                self.assertFalse(self.run_helper('cutover', fail_move=move)[0])
                self.assertFalse(self.run_helper('check')[0])
                self.ok('restore'); self.ok('complete')
                self.assertEqual(self.snapshot(self.state), self.before)
                self.assertEqual(self.state.stat().st_ino, self.inode)
                shutil.rmtree(self.operation)

    def test_each_restore_rename_window_is_recoverable(self):
        for move in (1, 2):
            with self.subTest(move=move):
                self.converted(); self.ok('cutover'); self.ok('ready')
                self.assertFalse(self.run_helper('restore', fail_move=move)[0])
                self.ok('restore'); self.ok('complete')
                self.assertEqual(self.snapshot(self.state), self.before)
                self.assertEqual(self.failed.joinpath('authority.sqlite').read_bytes(), b'converted candidate database')
                shutil.rmtree(self.operation)

    def test_unknown_inode_and_changed_original_never_cut_over(self):
        self.converted()
        self.write(self.state / 'records.sqlite', b'unexpected live writer')
        self.assertFalse(self.run_helper('cutover')[0])
        self.state.rename(self.root / 'unknown-original')
        self.state.mkdir(mode=0o700)
        self.assertFalse(self.run_helper('restore')[0])
        self.assertTrue(self.next.exists())

    def test_unsafe_files_and_insufficient_space_refuse_before_a_journal(self):
        for kind in ('symlink', 'hardlink', 'fifo', 'writable'):
            with self.subTest(kind=kind):
                path = self.state / 'unsafe'
                if kind == 'symlink': path.symlink_to(self.state / 'authority.sqlite')
                elif kind == 'hardlink': os.link(self.state / 'authority.sqlite', path)
                elif kind == 'fifo': os.mkfifo(path)
                else: self.write(path, b'x'); path.chmod(0o666)
                self.assertFalse(self.run_helper('prepare')[0]); path.unlink()
                self.assertFalse(self.operation.exists())
        with patch.object(shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(100, 99, 1)):
            self.assertFalse(self.run_helper('prepare')[0])
        self.assertEqual(self.snapshot(self.state), self.before)

    def test_promotion_requires_ready_state_and_exact_candidate_acceptance(self):
        self.converted()
        self.assertFalse(self.run_helper('promote')[0])
        self.ok('cutover'); self.ok('ready')
        self.assertFalse(self.run_helper('promote')[0])
        self.write(self.accepted, self.candidate.read_bytes())
        self.ok('check'); self.ok('promote'); self.ok('promote')
        self.assertFalse(self.run_helper('restore')[0])
        self.assertEqual(self.snapshot(self.backup), self.before)

class V8ToV9StateMigration(StateMigration):
    migration = 'v8-to-v9'

unittest.main()
