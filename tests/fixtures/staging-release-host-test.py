"""Hermetic host protocol proof; never uses AWS, Docker, metadata or live state."""
import copy
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
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
        original_fstat = os.fstat
        def fixture_fstat(fd):
            info = original_fstat(fd)
            for path in (self.root / 'clean-data', *self.owner_overrides):
                try:
                    candidate = original_lstat(path)
                except FileNotFoundError:
                    continue
                if (candidate.st_dev, candidate.st_ino) == (info.st_dev, info.st_ino):
                    fields = list(info)
                    fields[4], fields[5] = self.data_owner if path == self.root / 'clean-data' else self.owner_overrides[path]
                    return os.stat_result(fields)
            return info
        self.fstat_patcher = patch.object(os, 'fstat', fixture_fstat)
        self.fstat_patcher.start()
        self.write('clean-data/release/current.clean-v1.json', accepted_bytes)
        self.write('.env.clean-v1', b'ECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org\nPRIVATE_FIXTURE=never-print-this-value\n')
        paths = {name: ('deploy/' if name.startswith('release/') else 'deploy/organization-authority/') + name for name in host.TOOLS}
        for name, source in paths.items():
            self.write(name, f'old-reviewed-tool:{source}\n'.encode(), 0o755)
        # Production enforces every root-owned ancestor; the macOS test fixture
        # necessarily sits beneath a shared temporary directory.
        original = host.directory
        self.patcher = patch.object(host, 'directory', lambda path, private=False: original(path, private) if not path.is_absolute() or path == self.root or self.root in path.parents else None)
        self.patcher.start()
        self.calls = []

    def tearDown(self):
        self.patcher.stop()
        self.stat_patcher.stop()
        self.fstat_patcher.stop()
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
        self.assertTrue((root / '.staging-release-guard/owner-pid').is_file())
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

    def test_replaced_release_path_cannot_substitute_wrapper_inputs(self):
        self.install()
        seen = []
        request = self.request('stage')
        def attack(root, operation, args):
            release = root / 'clean-data/release'
            saved = root / 'clean-data/release-before-swap'
            release.rename(saved)
            shutil.copytree(saved, release)
            decoy = release / 'remote-operations' / request['operation_id'] / 'candidate.json'
            decoy.write_bytes(b'{"different":"candidate"}\n')
            seen.append(host.sha(pathlib.Path(args[2]).read_bytes()))
            return True, 'verified', None
        result = self.execute(request, invoke=attack)
        self.assertEqual(seen, [request['candidate']['sha256']])
        self.assertEqual(result['code'], 'control_path_changed')
        self.assertTrue((self.root / '.staging-release-guard').is_dir())
        self.assertFalse((self.root / 'clean-data/release/remote-operations' / request['operation_id'] / 'result.json').exists())

    def test_root_guard_survives_a_release_swap_and_blocks_second_operator(self):
        self.install()
        outcomes = []
        def attack(root, operation, args):
            (root / 'clean-data/release').rename(root / 'clean-data/release-before-swap')
            (root / 'clean-data/release').mkdir(mode=0o700)
            outcomes.append(self.execute(self.request('status'))['code'])
            return True, 'verified', None
        self.execute(self.request('status'), invoke=attack)
        self.assertEqual(outcomes, ['operation_locked'])

    def test_real_wrapper_inherits_pinned_cwd_and_root_owned_inputs(self):
        self.install()
        request = self.request('stage')
        observed = []
        def attack(root, operation, args):
            release = root / 'clean-data/release'
            saved = root / 'clean-data/release-before-swap'
            release.rename(saved)
            shutil.copytree(saved, release)
            (release / 'current.clean-v1.json').write_bytes(b'decoy accepted record')
            probe = '''#!/bin/sh
set -eu
python3 - "$@" <<'PY'
import hashlib, os, pathlib, sys
assert os.environ['ECHO_CLEAN_RELEASE_STATE_DIR'] == '.'
assert hashlib.sha256(pathlib.Path('current.clean-v1.json').read_bytes()).hexdigest() == 'ACCEPTED_HASH'
assert hashlib.sha256(pathlib.Path(sys.argv[3]).read_bytes()).hexdigest() == 'CANDIDATE_HASH'
assert pathlib.Path(os.environ['ECHO_CLEAN_OPERATION_LOCK_DIR']).parent.name == '.staging-release-guard'
PY
'''.replace('ACCEPTED_HASH', host.sha(accepted_bytes)).replace('CANDIDATE_HASH', request['candidate']['sha256'])
            # Root-side stub isolates the real subprocess handoff, not Docker.
            self.write('update-clean-v1.sh', probe.encode(), 0o755)
            observed.append(host.wrapper(root, operation, args))
            return observed[-1]
        self.assertEqual(self.execute(request, invoke=attack)['code'], 'control_path_changed')
        self.assertEqual(observed, [(True, 'verified', None)])

    def test_actual_updater_copy_preserves_pinned_relative_io_for_temporary_files(self):
        source = host.base64.b64decode(base['files']['update-clean-v1.sh']['base64']).decode()
        code = re.search(r"^copy_record\(\).*?<<'PY'\n(.*?)^PY$", source, re.M | re.S).group(1)
        release = self.root / 'clean-data/release'
        held = self.root / 'clean-data/release-held'
        held_again = self.root / 'clean-data/release-held-again'
        original_cwd = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
        original_abspath, original_link = os.path.abspath, os.link
        converted = []
        def reify_then_swap(path):
            absolute = original_abspath(path)
            if not os.path.isabs(path):
                converted.append(absolute)
                held.rename(held_again)
                held.mkdir(mode=0o700)
            return absolute
        def substitute_temporary(path, destination, *args, **kwargs):
            if converted and pathlib.Path(path).is_absolute():
                # A writable parent permits replacing a root-owned temp name.
                pathlib.Path(path).unlink()
                pathlib.Path(path).write_bytes(b'substituted fixture')
            return original_link(path, destination, *args, **kwargs)
        try:
            os.chdir(release)
            release.rename(held)
            release.mkdir(mode=0o700)
            with patch.object(sys, 'argv', ['copy-proof', 'current.clean-v1.json', 'copied.json', 'no-replace']), patch.object(os.path, 'abspath', reify_then_swap), patch.object(os, 'link', substitute_temporary):
                exec(compile(code, '<actual-updater-copy>', 'exec'), {})
            self.assertEqual(pathlib.Path('copied.json').read_bytes(), accepted_bytes)
            self.assertEqual(converted, [], 'temporary publication must not reify the pinned cwd')
        finally:
            os.fchdir(original_cwd)
            os.close(original_cwd)

    def test_installed_wrappers_hold_root_guard_even_if_legacy_lock_is_renamed(self):
        self.install()
        for name in ('update-clean-v1.sh', 'onboard-clean-v1.sh', 'backup-authority-maintenance.sh'):
            source = (self.root / name).read_text()
            functions = '\n'.join(re.search(r'^' + function + r'\(\) \{\n.*?^\}', source, re.M | re.S).group() for function in ('release_operation_lock', 'acquire_operation_lock', 'acquire_staging_release_guard'))
            script = '''set -euo pipefail
DEPLOY_DIR=$1
OPERATION_LOCK_DIR="$DEPLOY_DIR/clean-data/.authority-operation-lock"
OPERATION_LOCK_HELD=false
STAGING_RELEASE_GUARD_HELD=false
fail() { exit 42; }
''' + functions + '\n'
            guard = self.root / '.staging-release-guard'
            guard.mkdir(mode=0o700)
            blocked = subprocess.run(['bash', '-c', script + 'acquire_operation_lock', 'proof', str(self.root)], capture_output=True)
            self.assertEqual(blocked.returncode, 42, name)
            self.assertFalse((self.root / 'clean-data/.authority-operation-lock').exists())
            guard.rmdir()
            raced = script + '''
acquire_operation_lock
mv "$OPERATION_LOCK_DIR" "$OPERATION_LOCK_DIR.renamed"
if (STAGING_RELEASE_GUARD_HELD=false; OPERATION_LOCK_HELD=false; acquire_operation_lock); then exit 99; fi
test -f "$DEPLOY_DIR/.staging-release-guard/owner-pid"
release_operation_lock
'''
            blocked = subprocess.run(['bash', '-c', raced, 'proof', str(self.root)], capture_output=True)
            self.assertEqual(blocked.returncode, 0, name + blocked.stderr.decode())
            self.assertFalse((self.root / 'clean-data/.authority-operation-lock').exists())
            self.assertFalse(guard.exists())
            renamed = self.root / 'clean-data/.authority-operation-lock.renamed'
            self.assertTrue((renamed / 'owner-pid').is_file())
            shutil.rmtree(renamed)

    def test_regular_read_validates_the_open_inode_and_rejects_symlinks(self):
        target = self.root / 'regular-target'
        target.write_bytes(b'fixture')
        target.chmod(0o600)
        link = self.root / 'regular-link'
        link.symlink_to(target)
        with self.assertRaises(OSError):
            host.regular(link, True)
        self.assertEqual(host.regular(target, True), b'fixture')

    def test_existing_root_guard_is_preserved_even_when_symlinked(self):
        guard = self.root / '.staging-release-guard'
        guard.symlink_to('/missing-guard-fixture')
        self.assertEqual(self.execute(self.request('install'))['code'], 'operation_locked')
        self.assertTrue(guard.is_symlink())

    def test_swap_after_open_is_checked_on_the_open_descriptor(self):
        self.install()
        original_open = os.open
        def attack(path, *args, **kwargs):
            fd = original_open(path, *args, **kwargs)
            if path == 'release' and kwargs.get('dir_fd') is not None:
                release = self.root / 'clean-data/release'
                release.rename(self.root / 'clean-data/release-before-swap')
                release.symlink_to('/missing-control-fixture')
            return fd
        with patch.object(os, 'open', attack):
            result = self.execute(self.request('status'))
        self.assertEqual(result['code'], 'control_path_changed')
        self.assertEqual(self.calls, [['status']])


unittest.main(verbosity=1)
