"""Local transport adapter. Executes the real host runner and real updater.

Only cloud identity/mount and the service UID on a non-root test machine are
simulated. Production has no path/environment override for this fixture.
Real root/service isolation is independently covered by the required POSIX proof.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys

repo, root, receipt_path = map(pathlib.Path, sys.argv[1:])
assert (root / 'fixture-owner').read_text() == 'staging-journey-v1\n'
spec = importlib.util.spec_from_file_location('host', repo / 'tools/authority-staging-release-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
receipt = json.loads(receipt_path.read_text())
request = receipt['request']
deploy = root / 'host'
data = deploy / 'clean-data'
original_directory = host.directory
host.directory = lambda path, private=False: original_directory(path, private) if not path.is_absolute() or path == deploy or deploy in path.parents else None
original_lstat = pathlib.Path.lstat
data_info = data.stat()
original_fstat = os.fstat


def owner(info):
    if (info.st_dev, info.st_ino) == (data_info.st_dev, data_info.st_ino):
        fields = list(info)
        fields[4], fields[5] = 999, 988
        return os.stat_result(fields)
    return info


pathlib.Path.lstat = lambda path, *args, **kwargs: owner(original_lstat(path, *args, **kwargs))
os.fstat = lambda fd: owner(original_fstat(fd))
original_popen = subprocess.Popen


def popen(args, **kwargs):
    # Keep wrapper() itself, output redaction, cwd pinning and action selection.
    if args[0] == str(deploy / 'update-clean-v1.sh'):
        kwargs['env'] = {**kwargs['env'], 'PATH': str(root / 'bin') + ':' + os.environ['PATH']}
        child = original_popen(args, **kwargs)
        wait = child.wait

        def wait_with_evidence(*wait_args, **wait_kwargs):
            code = wait(*wait_args, **wait_kwargs)
            streams = {}
            for name in ('stdout', 'stderr'):
                stream = kwargs[name]
                position = stream.tell()
                stream.seek(0)
                streams[name] = stream.read(32768).decode(errors='replace')
                stream.seek(position)
            with (root / 'wrapper-output.jsonl').open('a') as output:
                output.write(json.dumps({'args': args[1:], 'code': code, **streams}) + '\n')
            return code

        child.wait = wait_with_evidence
        return child
    return original_popen(args, **kwargs)


subprocess.Popen = popen
original_wrapper = host.wrapper


def wrapper(deploy, operation, args):
    result = original_wrapper(deploy, operation, args)
    with (root / 'wrapper-evidence.jsonl').open('a') as output:
        output.write(json.dumps({'args': args, 'result': result}) + '\n')
    return result


result = host.execute_request(request, receipt['request_sha256'], root=deploy, identity=lambda *_: None, invoke=wrapper, now=lambda: request['created_at'] + 1)
print(json.dumps(result))
