#!/usr/bin/env python3
"""Docker seam for the full updater: SQLite copy/verifiers execute real code."""
import os
import pathlib
import subprocess
import sys

args = sys.argv[1:]
root = pathlib.Path(os.environ['ECHO_TEST_MIGRATION_ROOT'])
stopped = root / 'stopped'
environment = dict(line.split('=', 1) for line in pathlib.Path(os.environ['ECHO_CLEAN_ENV_FILE']).read_text().splitlines() if '=' in line)
if args[0] == 'pull': raise SystemExit(0)
if args[0] == 'compose':
    if args[-1] == 'down': stopped.write_text('stopped'); raise SystemExit(0)
    if 'ps' in args and stopped.exists(): raise SystemExit(0)
    if 'up' in args:
        if (root / 'fail-candidate-start').exists() and environment['ECHO_CLEAN_RELEASE_ID'] == 'clean-v1-migration-candidate': raise SystemExit(1)
        stopped.unlink(missing_ok=True)
if args[0] == 'run':
    assert args[args.index('--network') + 1] == 'none'
    assert '--read-only' in args and args[args.index('--cap-drop') + 1] == 'ALL'
    assert args[args.index('--security-opt') + 1] == 'no-new-privileges'
    assert args[args.index('--user') + 1] == f'{os.getuid()}:{os.getgid()}'
    mounts = dict((parts['dst'], parts) for value in [args[i + 1] for i, item in enumerate(args) if item == '--mount'] for parts in [dict(item.split('=', 1) if '=' in item else (item, True) for item in value.split(','))])
    script = args[-1]
    if 'copyAuthorityV5ToV6' in script:
        assert stopped.exists(), 'conversion requires stopped services'
        assert mounts['/source']['readonly'] is True and 'readonly' not in mounts['/candidate']
        if (root / 'fail-conversion').exists(): raise SystemExit(1)
        script = script.replace('/source/', mounts['/source']['src'] + '/').replace('/candidate/', mounts['/candidate']['src'] + '/')
    else:
        assert mounts['/echo-clean/state']['readonly'] is True
        state = mounts['/echo-clean/state']['src']
        image = args[args.index('--input-type=module') - 1]
        if image == os.environ['ECHO_TEST_ACCEPTED_IMAGE']:
            # The old image's complete verifier differs only in Authority's
            # pinned baseline. Execute that verifier with its real dependencies.
            source = pathlib.Path('packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js').resolve()
            script = source.read_text().replace('V6', 'V5').replace('"../', '"' + str(source.parent.parent) + '/')
            script += '\nverifyAuthorityStateLineage(' + repr(state) + ');'
        else:
            if (root / 'fail-candidate-verify').exists(): raise SystemExit(1)
            script = script.replace('/echo-clean/state', state)
    raise SystemExit(subprocess.run(['node', '--input-type=module', '-e', script]).returncode)
os.execv(str(root / 'bin/docker-fallback'), [str(root / 'bin/docker-fallback'), *args])
