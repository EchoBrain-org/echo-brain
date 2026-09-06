"""Fixed, non-interactive staging release transport, embedded by the repository CLI.

Not an installed general-purpose command. The CLI binds this exact reviewed
source and all transported non-secret bytes to one expiring request. Private
runtime files never leave the host. Existing updater semantics own activation.
"""
import base64
import contextlib
import gzip
import hashlib
import io
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
import urllib.request

DEPLOY = pathlib.Path('/srv/echo-authority-clean-v1')
TOOLS = ('update-clean-v1.sh', 'onboard-clean-v1.sh', 'restore-clean-v1-host.sh', 'backup-authority-maintenance.sh', 'release/clean-v1-release.py', 'release/clean-v1-runtime-profile.py')
ACTIONS = ('install', 'inspect-install', 'diagnose', 'repair', 'stage', 'canary', 'status', 'rollback', 'promote')
SAFE_CODES = ('installed', 'installation_failed', 'inspection_verified', 'inspection_refused', 'verified', 'wrapper_failed', 'environment_drift', 'precondition_failed', 'operation_locked', 'operation_incomplete', 'expired', 'delivery_pending', 'control_path_changed')
INSPECTION_CATEGORIES = ('ready', 'identity_invalid', 'retained_mount_invalid', 'deployment_path_invalid', 'data_ownership_invalid', 'release_control_invalid', 'operation_locked', 'legacy_lock_present', 'operation_incomplete', 'request_expired', 'accepted_record_invalid', 'accepted_record_mismatch', 'environment_invalid', 'hostname_mismatch', 'candidate_present', 'tool_missing', 'tool_file_invalid', 'tool_hash_unknown', 'repair_pending', 'inspection_failed', 'control_path_changed')
TOOL_CATEGORIES = ('tool_missing', 'tool_file_invalid', 'tool_hash_unknown')
WRAPPER_TIMEOUT_SECONDS = 1000
WRAPPER_TERM_GRACE_SECONDS = 5
WRAPPER_KILL_REAP_SECONDS = 5
WRAPPER_STREAM_BYTES = 65536
WRAPPER_READ_BYTES = 16384
WRAPPER_TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024
WRAPPER_DIAGNOSE_STDOUT_BYTES = 65536


class Refused(Exception):
    def __init__(self, code='precondition_failed', tool=None, inventory=None):
        super().__init__(code)
        self.code = code
        self.tool = tool
        self.inventory = inventory


class InterruptedWrapper(Exception):
    """A forced stop leaves the operation incomplete until an operator inspects it."""


def require(condition, code='precondition_failed'):
    if not condition:
        raise Refused(code)


@contextlib.contextmanager
def checked(category):
    """Classify a fixed guard without retaining filesystem/exception detail."""
    try:
        yield
    except Exception:
        raise Refused(category) from None


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def directory(path, private=False):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022)
    if private:
        require(stat.S_IMODE(info.st_mode) == 0o700)


def authority_data_directory(path):
    # Bootstrap and retained-host restore require this service-owned mount.
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (999, 988, 0o700))


def regular(path, private=False, limit=262144):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid() and not info.st_mode & 0o022 and info.st_size <= limit)
        if private:
            require(not info.st_mode & 0o077)
        data = stream.read(limit + 1)
    require(len(data) <= limit)
    return data


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def immutable(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    sync_directory(path.parent)


def make_directory(path):
    try:
        path.mkdir(mode=0o700)
        sync_directory(path.parent)
    except FileExistsError:
        pass
    directory(path, True)


def validate_request(request):
    migration = request.get('schema_version') == 3
    expected = {'schema_version', 'kind', 'operation_id', 'action', 'created_at', 'expires_at', 'target', 'tooling_source', 'previous_tooling_source', 'accepted', 'candidate', 'files', 'old_tool_hashes', 'content_telemetry', 'approval'} | ({'tooling_migration'} if migration else set())
    require(set(request) == expected)
    require(request['schema_version'] in (2, 3) and request['kind'] == f"echo-staging-release-request-v{request['schema_version']}")
    if migration:
        require(request['tooling_migration'] == 'legacy-staging-host-v1' and request['action'] in ('install', 'inspect-install'))
    require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request['operation_id']) is not None)
    require(request['action'] in ACTIONS)
    require(type(request['created_at']) is int and request['expires_at'] == request['created_at'] + 1800)
    target = request['target']
    require(set(target) == {'account', 'region', 'stack_id', 'instance_id', 'volume_id'})
    require(target['account'] == '904560150024' and target['region'] == 'us-west-2')
    require(re.fullmatch(r'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-authority-staging-v1/[a-f0-9-]+', target['stack_id']) is not None)
    require(re.fullmatch(r'i-[a-f0-9]{17}', target['instance_id']) is not None)
    require(re.fullmatch(r'vol-[a-f0-9]{17}', target['volume_id']) is not None)
    for commit in ('tooling_source', 'previous_tooling_source'):
        require(re.fullmatch(r'[a-f0-9]{40}', request[commit]) is not None)
    require(set(request['files']) == set(TOOLS) | {'candidate.json', 'runtime-profile.json'})
    require(set(request['old_tool_hashes']) == set(TOOLS))
    files = {}
    for name, artifact in request['files'].items():
        require(set(artifact) == {'sha256', 'base64'})
        data = base64.b64decode(artifact['base64'], validate=True)
        require(len(data) <= 196608 and sha(data) == artifact['sha256'])
        files[name] = data
    for name in TOOLS:
        require(re.fullmatch(r'[a-f0-9]{64}', request['old_tool_hashes'][name]) is not None)
    require(request['content_telemetry'] in (None, 'true', 'false'))
    require(request['action'] == 'stage' or request['content_telemetry'] is None)
    for binding in ('accepted', 'candidate'):
        require(re.fullmatch(r'clean-v1-[a-z0-9][a-z0-9-]{2,63}', request[binding]['release_id']) is not None)
        require(re.fullmatch(r'[a-f0-9]{64}', request[binding]['sha256']) is not None)
    candidate = json.loads(files['candidate.json'])
    require(candidate['release_id'] == request['candidate']['release_id'] and sha(files['candidate.json']) == request['candidate']['sha256'])
    require(candidate['person_client']['artifact_sha256'] == request['candidate']['person_client_sha256'])
    require(candidate['runtime_profile']['artifact_sha256'] == sha(files['runtime-profile.json']))
    if request['accepted']['release_id'] == request['candidate']['release_id']:
        require(request['action'] in ('install', 'inspect-install', 'diagnose', 'repair', 'status') and request['accepted']['sha256'] == request['candidate']['sha256'])
    approval = request['approval']
    if request['action'] == 'promote':
        require(isinstance(approval, dict) and set(approval) == {'kind', 'release_sha256', 'person_client_sha256', 'slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized'})
        require(approval['kind'] == 'echo-staging-release-founder-authorization-v1')
        require(approval['release_sha256'] == request['candidate']['sha256'] and approval['person_client_sha256'] == request['candidate']['person_client_sha256'])
        require(all(approval[key] is True for key in ('slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized')))
    else:
        require(approval is None)
    return files


def machine_identity(request, root):
    with checked('identity_invalid'):
        require(os.geteuid() == 0 and root == DEPLOY)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        token_request = urllib.request.Request('http://169.254.169.254/latest/api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
        with opener.open(token_request, timeout=3) as response:
            token = response.read(4096).decode()
        metadata_request = urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document', headers={'X-aws-ec2-metadata-token': token})
        with opener.open(metadata_request, timeout=3) as response:
            identity = json.loads(response.read(8192))
        target = request['target']
        require(identity.get('accountId') == target['account'] and identity.get('region') == target['region'] and identity.get('instanceId') == target['instance_id'])
    # Verify the retained volume, not a lookalike directory on the root disk.
    with checked('retained_mount_invalid'):
        require(os.path.ismount(root / 'clean-data'))
        device = subprocess.check_output(['/usr/bin/findmnt', '-n', '-o', 'SOURCE', '--target', str(root / 'clean-data')], stderr=subprocess.DEVNULL, timeout=5).decode().strip()
        serial = subprocess.check_output(['/usr/bin/lsblk', '-dn', '-o', 'SERIAL', device], stderr=subprocess.DEVNULL, timeout=5).decode().strip()
        require(serial.replace('-', '') == target['volume_id'].replace('-', ''))


class CapturedOutput:
    def __init__(self, limit, enforce_limit=False):
        self.limit = limit
        self.enforce_limit = enforce_limit
        self.value = bytearray()
        self.total = 0
        self.exceeded = False

    def append(self, chunk):
        self.total += len(chunk)
        remaining = self.limit - len(self.value)
        if remaining > 0:
            self.value.extend(chunk[:remaining])
        if self.enforce_limit and len(chunk) > remaining:
            self.exceeded = True


class OutputBudget:
    def __init__(self, limit):
        self.limit = limit
        self.total = 0

    @property
    def exceeded(self):
        return self.total > self.limit

    def append(self, chunk):
        self.total += len(chunk)


def process_group_alive(process_group):
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # A failure to inspect the group is not proof that it stopped.
        return True


def close_output(selector, streams):
    for stream in streams:
        if stream is None:
            continue
        try:
            selector.unregister(stream)
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass


def read_output(selector, captures, budget, timeout):
    """Drain both pipes while the wrapper runs, without retaining unbounded bytes."""
    for key, _ in selector.select(timeout):
        stream = key.fileobj
        try:
            # One chunk per ready descriptor keeps a continuous writer from
            # monopolising the deadline or starving the other stream.
            chunk = os.read(stream.fileno(), WRAPPER_READ_BYTES)
        except BlockingIOError:
            continue
        if not chunk:
            try:
                selector.unregister(stream)
            except Exception:
                pass
            stream.close()
            continue
        captures[stream].append(chunk)
        budget.append(chunk)


def output_exceeded(captures, budget):
    return budget.exceeded or any(capture.exceeded for capture in captures.values())


def drain_output(selector, captures, budget, deadline):
    """Consume an exited group's remaining pipe bytes without an unbounded read."""
    while selector.get_map():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        read_output(selector, captures, budget, min(remaining, 0.1))
        if output_exceeded(captures, budget):
            return False
    return True


def wait_for_group(child, selector, captures, budget, deadline):
    """Keep draining while waiting for both the leader and all descendants."""
    while True:
        if child.poll() is not None and not process_group_alive(child.pid):
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        read_output(selector, captures, budget, min(remaining, 0.1))


def stop_group(child, selector, captures, budget):
    """Use two bounded phases; never turn a failed wrapper into an unbounded wait."""
    for signal_to_send, seconds in ((signal.SIGTERM, WRAPPER_TERM_GRACE_SECONDS), (signal.SIGKILL, WRAPPER_KILL_REAP_SECONDS)):
        try:
            os.killpg(child.pid, signal_to_send)
        except ProcessLookupError:
            pass
        except OSError:
            # Keep trying the finite policy. A later successful observation is
            # required before the caller can release the root guard.
            pass
        if wait_for_group(child, selector, captures, budget, time.monotonic() + seconds):
            return True
    return child.poll() is not None and not process_group_alive(child.pid)


def interrupt_wrapper(child, selector, captures, budget):
    """Always preserve the root guard after an attempted forced termination."""
    try:
        stop_group(child, selector, captures, budget)
    except Exception:
        pass
    raise InterruptedWrapper()


def wrapper(root, operation, args):
    # Inherit the descriptor-pinned release cwd; never resolve it back to its
    # service-replaceable pathname. Candidate inputs live under the root guard.
    environment = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin', 'HOME': '/root', 'LANG': 'C.UTF-8', 'ECHO_CLEAN_RELEASE_STATE_DIR': '.', 'ECHO_CLEAN_STATE_DIR': str(root / 'clean-data/state'), 'ECHO_CLEAN_OPERATION_LOCK_DIR': str(root / '.staging-release-guard/wrapper-lock')}
    child = None
    selector = selectors.DefaultSelector()
    streams = []
    captures = {}
    budget = OutputBudget(WRAPPER_TOTAL_OUTPUT_BYTES)
    try:
        child = subprocess.Popen([str(root / 'update-clean-v1.sh'), *args], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        streams = [child.stdout, child.stderr]
        captures = {
            stream: CapturedOutput(
                WRAPPER_DIAGNOSE_STDOUT_BYTES if stream is child.stdout and args[0] == 'diagnose-environment' else WRAPPER_STREAM_BYTES,
                stream is child.stdout and args[0] == 'diagnose-environment',
            )
            for stream in streams
        }
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        deadline = time.monotonic() + WRAPPER_TIMEOUT_SECONDS
        while True:
            if output_exceeded(captures, budget):
                interrupt_wrapper(child, selector, captures, budget)
            if child.poll() is not None:
                # A direct child exiting is insufficient: a descendant may
                # retain stdout/stderr and continue the wrapper operation.
                if process_group_alive(child.pid):
                    interrupt_wrapper(child, selector, captures, budget)
                if not drain_output(selector, captures, budget, deadline):
                    interrupt_wrapper(child, selector, captures, budget)
                raw = bytes(captures[child.stdout].value)
                error = bytes(captures[child.stderr].value)
                code = child.returncode
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                interrupt_wrapper(child, selector, captures, budget)
            read_output(selector, captures, budget, min(remaining, 0.1))
    except InterruptedWrapper:
        raise
    except Exception:
        if child is not None:
            try:
                stop_group(child, selector, captures, budget)
            except Exception:
                pass
            raise InterruptedWrapper() from None
        return False, 'wrapper_failed', None
    finally:
        close_output(selector, streams)
        try:
            selector.close()
        except Exception:
            pass
    if code != 0:
        if b'release environment drifted from the accepted release record' in error:
            return False, 'environment_drift', None
        if b'staging canary delivery is still pending' in error:
            return False, 'delivery_pending', None
        return False, 'wrapper_failed', None
    if args[0] == 'diagnose-environment':
        require(len(raw) <= 65536)
        result = json.loads(raw)
        bools = {'candidate_staged', 'environment_matches', 'other_bytes_changed', 'allowlisted_settings_valid', 'environment_format_supported', 'repair_pending', 'repair_eligible', 'runtime_checked'}
        require(set(result) == bools | {'schema_version', 'kind', 'release_id', 'changed_settings'})
        require(all(type(result[key]) is bool for key in bools))
        require(result['schema_version'] == 1 and result['kind'] == 'echo-clean-v1-environment-drift' and result['runtime_checked'] is False)
        require(re.fullmatch(r'clean-v1-[a-z0-9][a-z0-9-]{2,63}', result['release_id']) is not None)
        require(result['changed_settings'] in ([], ['ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1']))
        return True, 'verified', result
    return True, 'verified', None


def result_for(request, request_hash, ok, code, diagnostic=None):
    require(code in SAFE_CODES)
    return {'schema_version': 1, 'kind': 'echo-staging-release-host-result-v1', 'operation_id': request['operation_id'], 'request_sha256': request_hash, 'action': request['action'], 'ok': ok, 'code': code, 'diagnostic': diagnostic}


def tooling_state(request, name, digest):
    if digest == request['files'][name]['sha256']:
        return 'new'
    return 'old' if digest == request['old_tool_hashes'][name] else 'unknown'


def migration_absence_allowed(request, name):
    return request.get('tooling_migration') == 'legacy-staging-host-v1' and name == 'backup-authority-maintenance.sh'


def inventory_problem(inventory, request):
    categories = {'missing': 'tool_missing', 'invalid': 'tool_file_invalid', 'unknown': 'tool_hash_unknown'}
    for name in TOOLS:
        if inventory[name]['state'] == 'missing' and migration_absence_allowed(request, name):
            continue
        if inventory[name]['state'] in categories:
            return categories[inventory[name]['state']], name
    return None, None


def valid_inventory(request, inventory, category, tool):
    if inventory is None:
        return category != 'ready' and category not in TOOL_CATEGORIES
    try:
        if type(inventory) is not dict or set(inventory) != set(TOOLS):
            return False
        for name, entry in inventory.items():
            if type(entry) is not dict or set(entry) != {'state', 'sha256'} or type(entry['state']) is not str:
                return False
            digest = entry['sha256']
            if entry['state'] in ('missing', 'invalid'):
                if digest is not None:
                    return False
            elif type(digest) is not str or re.fullmatch(r'[a-f0-9]{64}', digest) is None or entry['state'] != tooling_state(request, name, digest):
                return False
        problem = inventory_problem(inventory, request)
        if category in ('ready', 'repair_pending'):
            return problem == (None, None)
        return category in TOOL_CATEGORIES and problem == (category, tool)
    except Exception:
        return False


def read_tooling_inventory(request, root):
    # All names and parents are fixed/protected. Never hash an unsafe file or
    # any runtime/environment state; do not invoke installed tooling.
    inventory = {}
    for name in TOOLS:
        try:
            digest = sha(regular(root / name))
            inventory[name] = {'state': tooling_state(request, name, digest), 'sha256': digest}
        except FileNotFoundError:
            inventory[name] = {'state': 'missing', 'sha256': None}
        except Exception:
            inventory[name] = {'state': 'invalid', 'sha256': None}
    return inventory


def inspection_result(request, request_hash, category, tool=None, inventory=None):
    # Redact at the host boundary, before SSM sees the result. Client-side
    # validation is defense in depth, not a substitute for safe host output.
    valid_tool = type(tool) is str and tool in TOOLS if category in TOOL_CATEGORIES else tool is None
    if type(category) is not str or category not in INSPECTION_CATEGORIES or not valid_tool or not valid_inventory(request, inventory, category, tool):
        category, tool, inventory = 'inspection_failed', None, None
    diagnostic = {'schema_version': 2, 'kind': 'echo-staging-release-install-inspection-v2', 'category': category, 'tool': tool, 'inventory': inventory}
    return result_for(request, request_hash, category == 'ready', 'inspection_verified' if category == 'ready' else 'inspection_refused', diagnostic)


def inspection_failure(request, request_hash, error):
    category = error.code if isinstance(error, Refused) and error.code != 'ready' else 'inspection_failed'
    return inspection_result(request, request_hash, category, error.tool if isinstance(error, Refused) else None, error.inventory if isinstance(error, Refused) else None)


def installer_preconditions(request, root):
    """Shared, non-mutating install/inspection guard set."""
    with checked('accepted_record_invalid'):
        accepted = regular(pathlib.Path('current.clean-v1.json'), True, 16384)
        accepted_id = json.loads(accepted)['release_id']
    require(sha(accepted) == request['accepted']['sha256'] and accepted_id == request['accepted']['release_id'], 'accepted_record_mismatch')
    with checked('environment_invalid'):
        environment = regular(root / '.env.clean-v1', True, 1024 * 1024)
        require(environment.endswith(b'\n') and b'\r' not in environment and b'\0' not in environment, 'environment_invalid')
        for line in environment.splitlines():
            if line and not line.startswith(b'#'):
                require(re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_]*=[^\'"\\$`]*', line) is not None, 'environment_invalid')
    require([line for line in environment.splitlines() if line.startswith(b'ECHO_CLEAN_AUTHORITY_HOST=')] == [b'ECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org'], 'hostname_mismatch')
    candidate_path = pathlib.Path('candidate.clean-v1.json')
    candidate_present = candidate_path.exists() or candidate_path.is_symlink()
    if candidate_present:
        try:
            require(sha(regular(candidate_path, True, 16384)) == request['candidate']['sha256'], 'candidate_present')
        except Exception:
            raise Refused('candidate_present')
    if request['action'] in ('install', 'inspect-install', 'repair', 'stage'):
        require(not candidate_present, 'candidate_present')
    if request['action'] in ('canary', 'promote', 'rollback'):
        require(candidate_present)
    old_hashes, inventory = {}, None
    if request['action'] == 'inspect-install':
        inventory = read_tooling_inventory(request, root)
        problem, tool = inventory_problem(inventory, request)
        if problem is not None:
            raise Refused(problem, tool, inventory)
        old_hashes = {name: entry['sha256'] for name, entry in inventory.items()}
    else:
        for name in TOOLS:
            try:
                old_hashes[name] = sha(regular(root / name))
            except FileNotFoundError:
                if migration_absence_allowed(request, name):
                    old_hashes[name] = None
                    continue
                raise Refused('tool_missing', name)
            except Exception:
                raise Refused('tool_file_invalid', name)
            allowed = {request['files'][name]['sha256']}
            if request['action'] == 'install':
                allowed.add(request['old_tool_hashes'][name])
            if old_hashes[name] not in allowed:
                raise Refused('tool_hash_unknown', name)
    if request['action'] in ('install', 'inspect-install'):
        pending = pathlib.Path('environment-repair.pending.json')
        if pending.exists() or pending.is_symlink():
            raise Refused('repair_pending', inventory=inventory)
    return candidate_present, old_hashes, inventory


def execute_request(request, request_hash, root=DEPLOY, identity=machine_identity, invoke=wrapper, now=time.time):
    """Dependency seams are for hermetic tests; main supplies no overrides."""
    files = validate_request(request)
    try:
        identity(request, root)
    except Exception as error:
        if request['action'] == 'inspect-install':
            return inspection_failure(request, request_hash, error) if isinstance(error, Refused) else inspection_result(request, request_hash, 'identity_invalid')
        raise
    # Validate every existing parent component before reading or creating paths.
    try:
        with checked('deployment_path_invalid'):
            for ancestor in reversed(root.parents):
                directory(ancestor)
            directory(root)
            directory(root / 'release')
        with checked('data_ownership_invalid'):
            authority_data_directory(root / 'clean-data')
    except Exception as error:
        if request['action'] == 'inspect-install':
            return inspection_failure(request, request_hash, error)
        raise
    lock = root / '.staging-release-guard'
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        if request['action'] == 'inspect-install':
            return inspection_result(request, request_hash, 'operation_locked')
        return result_for(request, request_hash, False, 'operation_locked')
    cwd_fd = data_fd = release_fd = None
    keep_guard = False
    def binding_ok():
        try:
            current = os.stat('release', dir_fd=data_fd, follow_symlinks=False)
            opened = os.fstat(release_fd)
            return (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino)
        except OSError:
            return False
    try:
        immutable(lock / 'owner-pid', f'{os.getpid()}\n'.encode())
        sync_directory(root)
        legacy = root / 'clean-data/.authority-operation-lock'
        if legacy.exists() or legacy.is_symlink():
            if request['action'] == 'inspect-install':
                return inspection_result(request, request_hash, 'legacy_lock_present')
            return result_for(request, request_hash, False, 'operation_locked')
        with checked('data_ownership_invalid'):
            data_fd = os.open(root / 'clean-data', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            data_info = os.fstat(data_fd)
            require((data_info.st_uid, data_info.st_gid, stat.S_IMODE(data_info.st_mode)) == (999, 988, 0o700))
        with checked('release_control_invalid'):
            release_fd = os.open('release', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=data_fd)
            info = os.fstat(release_fd)
            require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700)
        cwd_fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
        os.fchdir(release_fd)
        result = execute_pinned(request, request_hash, root, files, invoke, now, binding_ok)
        if not binding_ok():
            keep_guard = True
            if request['action'] == 'inspect-install':
                return inspection_result(request, request_hash, 'control_path_changed')
            return result_for(request, request_hash, False, 'control_path_changed')
        return result
    except InterruptedWrapper:
        # A timeout, excess output, or lingering descendant does not prove
        # that Docker-side work stopped. Keep the root guard and leave the
        # operation without a result so it cannot be replayed automatically.
        keep_guard = True
        return result_for(request, request_hash, False, 'operation_incomplete')
    except Exception as error:
        if request['action'] == 'inspect-install':
            if release_fd is not None and not binding_ok():
                keep_guard = True
                return inspection_result(request, request_hash, 'control_path_changed')
            return inspection_failure(request, request_hash, error)
        raise
    finally:
        if release_fd is not None and not binding_ok():
            keep_guard = True
        if cwd_fd is not None:
            os.fchdir(cwd_fd)
        for fd in (cwd_fd, release_fd, data_fd):
            if fd is not None:
                os.close(fd)
        if not keep_guard:
            # This parent is root-owned and not mounted into the service.
            for name in ('candidate.json', 'runtime-profile.json', 'owner-pid'):
                path = lock / name
                if path.exists():
                    expected = f'{os.getpid()}\n'.encode() if name == 'owner-pid' else files[name]
                    require(regular(path, True) == expected)
                    path.unlink()
            lock.rmdir()
            sync_directory(root)


def execute_pinned(request, request_hash, root, files, invoke, now, binding_ok):
    # All control-state paths stay relative to the verified cwd inode.
    operations = pathlib.Path('remote-operations')
    make_directory(operations)
    operation = operations / request['operation_id']
    if operation.exists() or operation.is_symlink():
        directory(operation, True)
        require(regular(operation / 'request.sha256', True).decode() == request_hash + '\n')
        if (operation / 'result.json').exists():
            result = json.loads(regular(operation / 'result.json', True))
            require(result['request_sha256'] == request_hash)
            return result
        if request['action'] == 'inspect-install':
            return inspection_result(request, request_hash, 'operation_incomplete')
        return result_for(request, request_hash, False, 'operation_incomplete')
    if now() > request['expires_at'] or now() < request['created_at'] - 60:
        if request['action'] == 'inspect-install':
            return inspection_result(request, request_hash, 'request_expired')
        return result_for(request, request_hash, False, 'expired')
    make_directory(operation)
    immutable(operation / 'request.sha256', (request_hash + '\n').encode())
    immutable(operation / 'request.json', canonical(request))
    installing = False
    try:
        candidate_present, old_hashes, inventory = installer_preconditions(request, root)
        if request['action'] == 'inspect-install':
            result = inspection_result(request, request_hash, 'ready', inventory=inventory)
        elif request['action'] == 'install':
            installing = True
            # Preflight all existing tools before replacing any one of them.
            immutable(operation / 'tooling-before.json', canonical(old_hashes))
            for index, name in enumerate(TOOLS):
                try:
                    original = regular(root / name)
                    immutable(operation / f'tool-{index}.before', original)
                except FileNotFoundError:
                    require(migration_absence_allowed(request, name) and old_hashes[name] is None)
                    immutable(operation / f'tool-{index}.absent', b'absent\n')
                # clean-data may be a separate filesystem from deployment.
                # Create the final temp beside its destination, then rename.
                destination = root / name
                fd, temp_path = tempfile.mkstemp(prefix='.echo-tool-', dir=destination.parent)
                try:
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(files[name])
                        os.fchmod(stream.fileno(), 0o755)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temp_path, destination)
                    sync_directory(destination.parent)
                finally:
                    if os.path.exists(temp_path):
                        os.unlink(temp_path)
                require(sha(regular(destination)) == request['files'][name]['sha256'])
            result = result_for(request, request_hash, True, 'installed')
        else:
            for name in ('candidate.json', 'runtime-profile.json'):
                immutable(operation / name, files[name])
                immutable(root / '.staging-release-guard' / name, files[name])
            inputs = root / '.staging-release-guard'
            action = request['action']
            args = {'diagnose': ['diagnose-environment'], 'status': ['status'], 'repair': ['repair-environment', '--expected-release-id', request['accepted']['release_id'], '--restore-accepted'], 'stage': ['stage', '--release', str(inputs / 'candidate.json'), '--runtime-profile', str(inputs / 'runtime-profile.json')], 'canary': ['canary'], 'rollback': ['rollback'], 'promote': ['promote', '--release', str(inputs / 'candidate.json'), '--canary-passed']}[action]
            if action == 'repair':
                ok, code, diagnostic = invoke(root, operation, ['diagnose-environment'])
                require(ok and diagnostic['release_id'] == request['accepted']['release_id'] and not diagnostic['candidate_staged'] and (diagnostic['repair_eligible'] or diagnostic['repair_pending']))
            if action == 'stage' and request['content_telemetry'] is not None:
                args += ['--content-telemetry', request['content_telemetry']]
            ok, code, diagnostic = invoke(root, operation, args)
            if diagnostic is not None:
                require(diagnostic['release_id'] == request['candidate' if candidate_present else 'accepted']['release_id'])
            result = result_for(request, request_hash, ok, code, diagnostic)
        if not binding_ok():
            result = inspection_result(request, request_hash, 'control_path_changed') if request['action'] == 'inspect-install' else result_for(request, request_hash, False, 'control_path_changed')
        immutable(operation / 'result.json', canonical(result))
        return result
    except InterruptedWrapper:
        raise
    except Exception as error:
        if request['action'] == 'inspect-install':
            result = inspection_failure(request, request_hash, error)
        else:
            result = result_for(request, request_hash, False, 'installation_failed' if installing else 'precondition_failed')
        if not (operation / 'result.json').exists():
            immutable(operation / 'result.json', canonical(result))
        return result


def main(payload, expected_hash):
    request = None
    validated = False
    try:
        require(os.geteuid() == 0)
        require(re.fullmatch(r'[a-f0-9]{64}', expected_hash) is not None)
        require(len(payload) <= 1024 * 1024)
        with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(payload, validate=True))) as compressed:
            raw = compressed.read(768 * 1024 + 1)
        require(len(raw) <= 768 * 1024 and sha(raw) == expected_hash)
        request = json.loads(raw)
        validate_request(request)
        validated = True
        result = execute_request(request, expected_hash)
    except Exception as error:
        # Neither exception strings nor subprocess output may enter SSM logs.
        if not validated:
            raise SystemExit(1)
        result = inspection_failure(request, expected_hash, error) if request['action'] == 'inspect-install' else result_for(request, expected_hash, False, 'precondition_failed')
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
