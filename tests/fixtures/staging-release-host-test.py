"""Hermetic host protocol proof; never uses AWS, Docker, metadata or live state."""
import copy
import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

runner_path, receipt_path, accepted_path = sys.argv[1:]
sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location('release_host', runner_path)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
base = json.loads(pathlib.Path(receipt_path).read_text())['request']
accepted_bytes = pathlib.Path(accepted_path).read_bytes()


class HostProtocol(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='echo-staging-host-proof-')
        self.root = pathlib.Path(self.temporary.name)
        for path in ('clean-data', 'clean-data/release', 'release'):
            (self.root / path).mkdir(mode=0o700)
        # Bootstrap's retained mount is service-owned, not root-owned. Model
        # that one inode's identity without requiring chown/root on test Macs.
        self.data_owner = (999, 988)
        self.owner_overrides = {}
        original_lstat = pathlib.Path.lstat
        def fixture_lstat(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            owner = self.data_owner if path == self.root / 'clean-data' else self.owner_overrides.get(path)
            if owner is not None:
                fields = list(info)
                fields[4], fields[5] = owner
                return os.stat_result(fields)
            return info
        self.stat_patcher = patch.object(pathlib.Path, 'lstat', fixture_lstat)
        self.stat_patcher.start()
        self.write('clean-data/release/current.clean-v1.json', accepted_bytes)
        self.write('.env.clean-v1', b'ECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org\nPRIVATE_FIXTURE=never-print-this-value\n')
        paths = {'update-clean-v1.sh': 'deploy/organization-authority/update-clean-v1.sh', 'release/clean-v1-release.py': 'deploy/release/clean-v1-release.py', 'release/clean-v1-runtime-profile.py': 'deploy/release/clean-v1-runtime-profile.py'}
        for name, source in paths.items():
            self.write(name, f'old-reviewed-tool:{source}\n'.encode(), 0o755)
        # Production enforces every root-owned ancestor; the macOS test fixture
        # necessarily sits beneath a shared temporary directory.
        original = host.directory
        self.patcher = patch.object(host, 'directory', lambda path, private=False: original(path, private) if path == self.root or self.root in path.parents else None)
        self.patcher.start()
        self.calls = []

    def tearDown(self):
        self.patcher.stop()
        self.stat_patcher.stop()
        self.temporary.cleanup()

    def write(self, name, data, mode=0o600):
        path = self.root / name
        path.write_bytes(data)
        path.chmod(mode)

    def request(self, action):
        value = copy.deepcopy(base)
        value['action'] = action
        value['operation_id'] = str(uuid.uuid4())
        value['content_telemetry'] = None
        return value

    def invoke(self, root, operation, args):
        self.calls.append(args)
        self.assertTrue((root / 'clean-data/.authority-operation-lock/owner-pid').is_file())
        if args[0] == 'diagnose-environment':
            return True, 'verified', {'release_id': base['accepted']['release_id'], 'candidate_staged': False, 'repair_eligible': True, 'repair_pending': False}
        return True, 'verified', None

    def execute(self, request, invoke=None, now=None):
        return host.execute_request(request, host.sha(host.canonical(request)), root=self.root, identity=lambda *_: None, invoke=invoke or self.invoke, now=now or (lambda: request['created_at'] + 1))

    def install(self):
        result = self.execute(self.request('install'))
        self.assertTrue(result['ok'], result)

    def candidate(self):
        self.write('clean-data/release/candidate.clean-v1.json', host.base64.b64decode(base['files']['candidate.json']['base64']))

    def test_install_is_exact_and_idempotent_without_runtime_mutation(self):
        request = self.request('install')
        before_env = (self.root / '.env.clean-v1').read_bytes()
        self.assertTrue(self.execute(request)['ok'])
        result = self.execute(request)
        self.assertTrue(result['ok'])
        self.assertEqual(self.calls, [])
        for name in host.TOOLS:
            self.assertEqual(host.sha((self.root / name).read_bytes()), request['files'][name]['sha256'])
            self.assertEqual((self.root / name).stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / '.env.clean-v1').read_bytes(), before_env)
        self.assertEqual((self.root / 'clean-data/release/current.clean-v1.json').read_bytes(), accepted_bytes)
        self.assertFalse((self.root / 'clean-data/release/candidate.clean-v1.json').exists())

    def test_data_root_requires_exact_bootstrap_owner_group_and_mode(self):
        before = (self.root / 'update-clean-v1.sh').read_bytes()
        for owner in ((0, 0), (999, 0), (0, 988), (1000, 1000)):
            with self.subTest(owner=owner):
                self.data_owner = owner
                with self.assertRaises(host.Refused):
                    self.execute(self.request('install'))
                self.assertFalse((self.root / 'clean-data/.authority-operation-lock').exists())
        self.data_owner = (999, 988)
        for mode in (0o755, 0o750, 0o770):
            with self.subTest(mode=mode):
                (self.root / 'clean-data').chmod(mode)
                with self.assertRaises(host.Refused):
                    self.execute(self.request('install'))
        (self.root / 'clean-data').chmod(0o700)
        self.assertEqual((self.root / 'update-clean-v1.sh').read_bytes(), before)
        self.assertEqual(self.calls, [])

    def test_data_root_symlink_is_not_a_service_owned_directory(self):
        data = self.root / 'clean-data'
        retained = self.root / 'retained-fixture'
        data.rename(retained)
        data.symlink_to(retained, target_is_directory=True)
        self.assertTrue(stat.S_ISLNK(data.lstat().st_mode))
        with self.assertRaises(host.Refused):
            self.execute(self.request('install'))
        self.assertFalse((retained / '.authority-operation-lock').exists())

    def test_service_ownership_is_not_allowed_for_release_control_paths(self):
        for name in ('release', 'clean-data/release'):
            with self.subTest(path=name):
                self.owner_overrides = {self.root / name: (999, 988)}
                with self.assertRaises(host.Refused):
                    self.execute(self.request('install'))
                self.assertFalse((self.root / 'clean-data/.authority-operation-lock').exists())

    def test_unknown_old_tool_refuses_before_any_replacement(self):
        self.write('release/clean-v1-runtime-profile.py', b'unreviewed bytes', 0o755)
        before = (self.root / 'update-clean-v1.sh').read_bytes()
        self.assertFalse(self.execute(self.request('install'))['ok'])
        self.assertEqual((self.root / 'update-clean-v1.sh').read_bytes(), before)

    def test_accepted_tuple_drift_refuses(self):
        self.write('clean-data/release/current.clean-v1.json', accepted_bytes + b' ')
        self.assertFalse(self.execute(self.request('install'))['ok'])
        self.assertEqual(self.calls, [])

    def test_staged_candidate_blocks_install_repair_and_stage(self):
        self.install()
        self.candidate()
        for action in ('install', 'repair', 'stage'):
            self.assertFalse(self.execute(self.request(action))['ok'])
        self.assertEqual(self.calls, [])

    def test_symlink_candidate_is_not_absence(self):
        (self.root / 'clean-data/release/candidate.clean-v1.json').symlink_to('/does-not-exist')
        self.assertFalse(self.execute(self.request('install'))['ok'])

    def test_symlink_tool_is_refused(self):
        (self.root / 'update-clean-v1.sh').unlink()
        (self.root / 'update-clean-v1.sh').symlink_to('/bin/sh')
        self.assertFalse(self.execute(self.request('install'))['ok'])

    def test_hostname_and_multiline_tricks_are_refused_without_output(self):
        for raw in (b'ECHO_CLEAN_AUTHORITY_HOST=production.example\n', b'PRIVATE="hello\nECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org\n"\n'):
            self.write('.env.clean-v1', raw)
            result = self.execute(self.request('install'))
            self.assertFalse(result['ok'])
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertNotIn('production.example', json.dumps(result))

    def test_existing_global_lock_is_preserved(self):
        path = self.root / 'clean-data/.authority-operation-lock'
        path.mkdir(mode=0o700)
        self.write('clean-data/.authority-operation-lock/owner-pid', b'12345\n')
        self.assertEqual(self.execute(self.request('install'))['code'], 'operation_locked')
        self.assertEqual((path / 'owner-pid').read_bytes(), b'12345\n')

    def test_expired_request_cannot_mutate_tools(self):
        request = self.request('install')
        self.assertEqual(self.execute(request, now=lambda: request['expires_at'] + 1)['code'], 'expired')
        self.assertEqual(self.calls, [])

    def test_incomplete_prior_operation_never_reexecutes(self):
        self.install()
        request = self.request('status')
        operation = self.root / 'clean-data/release/remote-operations' / request['operation_id']
        operation.mkdir(mode=0o700)
        self.write(str(operation.relative_to(self.root) / 'request.sha256'), (host.sha(host.canonical(request)) + '\n').encode())
        self.assertEqual(self.execute(request)['code'], 'operation_incomplete')
        self.assertEqual(self.calls, [])

    def test_repair_requires_positive_diagnostic_and_exact_accepted_id(self):
        self.install()
        request = self.request('repair')
        self.assertTrue(self.execute(request)['ok'])
        self.assertEqual(self.calls[-1], ['repair-environment', '--expected-release-id', base['accepted']['release_id'], '--restore-accepted'])
        self.calls.clear()
        def ineligible(root, operation, args):
            self.calls.append(args)
            return True, 'verified', {'release_id': base['accepted']['release_id'], 'candidate_staged': False, 'repair_eligible': False, 'repair_pending': False}
        self.assertFalse(self.execute(self.request('repair'), invoke=ineligible)['ok'])
        self.assertEqual(self.calls, [['diagnose-environment']])

    def test_stage_passes_telemetry_only_to_candidate_command(self):
        self.install()
        request = self.request('stage')
        request['content_telemetry'] = 'true'
        self.assertTrue(self.execute(request)['ok'])
        self.assertEqual(self.calls[-1][-2:], ['--content-telemetry', 'true'])
        self.assertEqual((self.root / 'clean-data/release/current.clean-v1.json').read_bytes(), accepted_bytes)

    def test_canary_and_rollback_require_exact_candidate(self):
        self.install()
        for action in ('canary', 'rollback'):
            self.assertFalse(self.execute(self.request(action))['ok'])
        self.candidate()
        self.assertTrue(self.execute(self.request('canary'))['ok'])
        self.assertEqual(self.calls[-1], ['canary'])

    def test_promotion_cannot_infer_human_approval(self):
        self.install()
        self.candidate()
        request = self.request('promote')
        with self.assertRaises(host.Refused):
            self.execute(request)
        request['approval'] = {'kind': 'echo-staging-release-founder-authorization-v1', 'release_sha256': request['candidate']['sha256'], 'person_client_sha256': request['candidate']['person_client_sha256'], 'slack_approved': True, 'person_records_passed': True, 'person_ask_passed': True, 'release_authorized': True}
        self.assertTrue(self.execute(request)['ok'])
        self.assertEqual(self.calls[-1][-1], '--canary-passed')

    def test_wrapper_failures_never_print_private_output(self):
        self.write('update-clean-v1.sh', b'#!/bin/sh\necho never-print-private-output\necho never-print-secret-error >&2\nexit 1\n', 0o755)
        operation = self.root / 'clean-data/release'
        result = host.wrapper(self.root, operation, ['status'])
        self.assertEqual(result, (False, 'wrapper_failed', None))


unittest.main(verbosity=1)
