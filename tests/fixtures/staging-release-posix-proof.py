"""Optional Linux/root proof in a network-disabled disposable container.

Only synthetic files in TemporaryDirectory are touched. No AWS, metadata,
Docker socket, real deployment, credentials, or application state is used.
Run with: python3 -B <this-file> <host-runner-source> <updater-source> <onboard-source>
"""
import base64
import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import uuid

assert sys.platform == 'linux' and os.geteuid() == 0
spec = importlib.util.spec_from_file_location('host', sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
updater_source = pathlib.Path(sys.argv[2]).read_text()
onboard_source = pathlib.Path(sys.argv[3]).read_text()
copy_helper = re.search(r"^copy_record\(\).*?<<'PY'\n(.*?)^PY$", updater_source, re.M | re.S).group(1)

with tempfile.TemporaryDirectory(prefix='echo-posix-proof-') as temporary:
    root = pathlib.Path(temporary)
    root.chmod(0o755)
    for name in ('clean-data', 'clean-data/release', 'release'):
        (root / name).mkdir(mode=0o700)
    os.chown(root / 'clean-data', 999, 988)

    def write(path, data, mode=0o600):
        path.write_bytes(data)
        path.chmod(mode)

    accepted = host.canonical({'release_id': 'clean-v1-accepted-fixture'})
    profile = b'{}\n'
    candidate = host.canonical({'release_id': 'clean-v1-candidate-fixture', 'person_client': {'artifact_sha256': 'c' * 64}, 'runtime_profile': {'artifact_sha256': host.sha(profile)}})
    write(root / 'clean-data/release/current.clean-v1.json', accepted)
    write(root / '.env.clean-v1', b'ECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org\n')
    probe = '''#!/bin/sh
set -eu
python3 - "$@" <<'PY'
import hashlib,os,pathlib,sys
assert os.environ['ECHO_CLEAN_RELEASE_STATE_DIR'] == '.'
assert hashlib.sha256(pathlib.Path('current.clean-v1.json').read_bytes()).hexdigest() == 'ACCEPTED'
assert hashlib.sha256(pathlib.Path(sys.argv[3]).read_bytes()).hexdigest() == 'CANDIDATE'
bound_input = sys.argv[3]
original_abspath = os.path.abspath
def prohibit_relative_reification(path):
 assert os.path.isabs(path), 'temporary publication reified the pinned cwd'
 return original_abspath(path)
os.path.abspath = prohibit_relative_reification
sys.argv = ['actual-updater-copy', bound_input, 'copied-candidate.json', 'no-replace']
exec(COPY_HELPER, {})
assert hashlib.sha256(pathlib.Path('copied-candidate.json').read_bytes()).hexdigest() == 'CANDIDATE'
PY
'''.replace('COPY_HELPER', repr(copy_helper)).replace('ACCEPTED', host.sha(accepted)).replace('CANDIDATE', host.sha(candidate)).encode()
    files = {}
    for name in host.TOOLS:
        content = probe if name == 'update-clean-v1.sh' else b'# synthetic reviewed tool fixture\n'
        write(root / name, content, 0o755)
        files[name] = {'sha256': host.sha(content), 'base64': base64.b64encode(content).decode()}
    old_hashes = {name: value['sha256'] for name, value in files.items()}
    for name, content in (('candidate.json', candidate), ('runtime-profile.json', profile)):
        files[name] = {'sha256': host.sha(content), 'base64': base64.b64encode(content).decode()}
    now = int(time.time())
    request = {'schema_version': 2, 'kind': 'echo-staging-release-request-v2', 'operation_id': str(uuid.uuid4()), 'action': 'stage', 'created_at': now, 'expires_at': now + 1800, 'target': {'account': '904560150024', 'region': 'us-west-2', 'stack_id': 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-authority-staging-v1/11111111-1111-4111-8111-111111111111', 'instance_id': 'i-0123456789abcdef0', 'volume_id': 'vol-0123456789abcdef0'}, 'tooling_source': 'a' * 40, 'previous_tooling_source': 'b' * 40, 'accepted': {'release_id': 'clean-v1-accepted-fixture', 'sha256': host.sha(accepted)}, 'candidate': {'release_id': 'clean-v1-candidate-fixture', 'sha256': host.sha(candidate), 'person_client_sha256': 'c' * 64}, 'files': files, 'old_tool_hashes': old_hashes, 'content_telemetry': None, 'approval': None}

    # Only the shared /tmp ancestors are exempted. All fixture inode owner,
    # group, mode, descriptor, and subprocess checks are real kernel checks.
    original_directory = host.directory
    host.directory = lambda path, private=False: original_directory(path, private) if not path.is_absolute() or path == root or root in path.parents else None

    def inspect_inventory(action='inspect-install', operation=None):
        value = {**request, 'operation_id': operation or str(uuid.uuid4()), 'action': action}
        def refuse_invocation(*_):
            raise AssertionError('inventory invoked installed tooling')
        return host.execute_request(value, host.sha(host.canonical(value)), root=root, identity=lambda *_: None, invoke=refuse_invocation)

    ready = inspect_inventory()
    assert ready['ok']
    assert ready['diagnostic']['inventory'] == {name: {'state': 'new', 'sha256': files[name]['sha256']} for name in host.TOOLS}
    unknown_tool = b'# unrecognized synthetic fixture\n'
    write(root / host.TOOLS[0], unknown_tool, 0o755)
    os.chown(root / host.TOOLS[1], 999, 988)
    (root / host.TOOLS[2]).unlink()
    (root / host.TOOLS[2]).symlink_to(root / '.env.clean-v1')
    (root / host.TOOLS[3]).unlink()
    write(root / 'fixture-hardlink', b'private fixture\n')
    os.link(root / 'fixture-hardlink', root / host.TOOLS[3])
    write(root / host.TOOLS[4], b'x' * 262145, 0o755)
    (root / host.TOOLS[5]).unlink()
    inventory_operation = str(uuid.uuid4())
    refused = inspect_inventory(operation=inventory_operation)
    assert not refused['ok'] and refused['diagnostic']['category'] == 'tool_hash_unknown'
    inventory = refused['diagnostic']['inventory']
    assert set(inventory) == set(host.TOOLS)
    assert inventory[host.TOOLS[0]] == {'state': 'unknown', 'sha256': host.sha(unknown_tool)}
    assert [inventory[name]['state'] for name in host.TOOLS[1:]] == ['invalid'] * 4 + ['missing']
    assert all(inventory[name]['sha256'] is None for name in host.TOOLS[1:])
    assert inspect_inventory(operation=inventory_operation) == refused
    assert not inspect_inventory(action='install')['ok']
    assert (root / host.TOOLS[0]).read_bytes() == unknown_tool
    assert not (root / '.staging-release-guard').exists()
    for name in host.TOOLS:
        (root / name).unlink(missing_ok=True)
        write(root / name, base64.b64decode(files[name]['base64']), 0o755)
    print('PASS: complete hash-only inventory with real UID/GID; unsafe files have no digest; unknown bytes remain refused')

    # The named migration retains real no-follow/owner/mode checks and records
    # the one expected absence; it must not grant a generic missing-file bypass.
    backup = root / 'backup-authority-maintenance.sh'
    backup.unlink()
    assert not inspect_inventory()['ok']
    migration = {**request, 'schema_version': 3, 'kind': 'echo-staging-release-request-v3', 'tooling_migration': 'legacy-staging-host-v1', 'action': 'install', 'operation_id': str(uuid.uuid4())}
    result = host.execute_request(migration, host.sha(host.canonical(migration)), root=root, identity=lambda *_: None)
    assert result['ok'] and result['code'] == 'installed'
    assert backup.stat().st_uid == 0 and backup.stat().st_mode & 0o777 == 0o755
    assert (root / 'clean-data/release/remote-operations' / migration['operation_id'] / 'tool-3.absent').read_bytes() == b'absent\n'
    print('PASS: named missing-helper migration publishes root-owned tools and preserves absence evidence')

    def invoke(deploy, operation, args):
        attack = '''import os,pathlib,sys
root=pathlib.Path(sys.argv[1])
assert os.geteuid()==999 and os.getegid()==988
release=root/'clean-data/release'
release.rename(root/'clean-data/release-original')
release.mkdir(mode=0o700)
(release/'current.clean-v1.json').write_bytes(b'decoy')
for action in (lambda: (root/'.staging-release-guard').rename(root/'guard-decoy'), lambda: pathlib.Path(sys.argv[2]).write_bytes(b'substituted')):
 try: action()
 except PermissionError: pass
 else: raise AssertionError('service crossed the root-owned interlock')
print('service-swap-completed-root-guard-protected')
'''
        attacked = subprocess.run(['python3', '-c', attack, str(root), args[2]], cwd='/tmp', user=999, group=988, extra_groups=[], capture_output=True, text=True, timeout=10)
        assert attacked.returncode == 0, attacked.stderr
        assert attacked.stdout.strip() == 'service-swap-completed-root-guard-protected'
        next_request = {**request, 'operation_id': str(uuid.uuid4()), 'action': 'status'}
        blocked = host.execute_request(next_request, host.sha(host.canonical(next_request)), root=root, identity=lambda *_: None)
        assert blocked['code'] == 'operation_locked'
        result = host.wrapper(root, operation, args)
        assert result == (True, 'verified', None), result
        return result

    result = host.execute_request(request, host.sha(host.canonical(request)), root=root, identity=lambda *_: None, invoke=invoke)
    assert result['code'] == 'control_path_changed', result
    assert (root / '.staging-release-guard/owner-pid').is_file()
    assert (root / '.staging-release-guard/candidate.json').read_bytes() == candidate
    assert not (root / 'clean-data/release/remote-operations').exists()
    assert (root / 'clean-data/release-original/remote-operations' / request['operation_id'] / 'result.json').is_file()
    functions = '\n'.join(re.search(r'^' + function + r'\(\) \{\n.*?^\}', onboard_source, re.M | re.S).group() for function in ('release_operation_lock', 'acquire_operation_lock', 'acquire_staging_release_guard'))
    shell = '''set -euo pipefail
DEPLOY_DIR=$1
OPERATION_LOCK_DIR="$DEPLOY_DIR/clean-data/.authority-operation-lock"
OPERATION_LOCK_HELD=false
STAGING_RELEASE_GUARD_HELD=false
fail() { exit 42; }
''' + functions + '''
acquire_operation_lock "$2"
test "$STAGING_RELEASE_GUARD_HELD" = false
release_operation_lock
test -f "$DEPLOY_DIR/.staging-release-guard/owner-pid"
'''
    for uid, action, owner, expected in ((0, 'resume', str(os.getpid()), 0), (999, 'resume', str(os.getpid()), 42), (0, 'prepare', str(os.getpid()), 42), (0, 'resume', str(os.getpid() + 1), 42)):
        environment = {**os.environ, 'ECHO_CLEAN_PARENT_GUARD_PID': owner}
        child = subprocess.run(['bash', '-c', shell, 'handoff-proof', str(root), action], cwd='/tmp', env=environment, user=uid, group=0 if uid == 0 else 988, extra_groups=[], capture_output=True, timeout=10)
        assert child.returncode == expected, (uid, action, owner, child.stderr)
        assert (root / '.staging-release-guard/owner-pid').read_text() == str(os.getpid()) + '\n'
    (root / '.staging-release-guard').chmod(0o755)
    invalid = subprocess.run(['bash', '-c', shell, 'handoff-proof', str(root), 'resume'], cwd='/tmp', env={**os.environ, 'ECHO_CLEAN_PARENT_GUARD_PID': str(os.getpid()), 'PYTHONOPTIMIZE': '1'}, capture_output=True, timeout=10)
    assert invalid.returncode == 42, invalid.stderr
    (root / '.staging-release-guard').chmod(0o700)
    print('PASS: real UID 999 isolation; actual updater copy stays pinned; second operator refused; only the bound root resume child inherits the retained parent guard')
