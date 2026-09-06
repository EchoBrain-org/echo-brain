"""Optional Linux/root proof in a network-disabled disposable container.

Only synthetic files in TemporaryDirectory are touched. No AWS, metadata,
Docker socket, real deployment, credentials, or application state is used.
Run with: python3 -B <this-file> <host-runner-source>
"""
import base64
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

assert sys.platform == 'linux' and os.geteuid() == 0
spec = importlib.util.spec_from_file_location('host', sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

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
PY
'''.replace('ACCEPTED', host.sha(accepted)).replace('CANDIDATE', host.sha(candidate)).encode()
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
    print('PASS: real UID 999 rename cannot substitute inputs or clear the root guard; root wrapper used pinned state; second operator refused')
