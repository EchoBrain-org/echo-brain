#!/usr/bin/env python3
"""Docker seam for the full updater: SQLite copy/verifiers execute real code."""
import os
import pathlib
import re
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
def execute_node(script):
    result = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True)
    if result.returncode:
        # Only synthetic fixture state is in scope; retain subprocess evidence
        # even when the real wrapper correctly redacts child diagnostics.
        (root / 'fixture-node-failure.log').write_bytes(result.stderr)
    return result.returncode

if args[0] == 'run':
    assert args[args.index('--network') + 1] == 'none'
    assert '--read-only' in args and args[args.index('--cap-drop') + 1] == 'ALL'
    assert args[args.index('--security-opt') + 1] == 'no-new-privileges'
    assert args[args.index('--user') + 1] == f'{os.getuid()}:{os.getgid()}'
    mounts = dict((parts['dst'], parts) for value in [args[i + 1] for i, item in enumerate(args) if item == '--mount'] for parts in [dict(item.split('=', 1) if '=' in item else (item, True) for item in value.split(','))])
    script = args[-1]
    if 'copyAuthorityV5ToV6' in script or 'copyAuthorityV8ToV9' in script:
        assert stopped.exists(), 'conversion requires stopped services'
        assert mounts['/source']['readonly'] is True and 'readonly' not in mounts['/candidate']
        if (root / 'fail-conversion').exists(): raise SystemExit(1)
        script = script.replace('/source/', mounts['/source']['src'] + '/').replace('/candidate/', mounts['/candidate']['src'] + '/')
    else:
        assert mounts['/echo-clean/state']['readonly'] is True
        state = mounts['/echo-clean/state']['src']
        image = args[args.index('--input-type=module') - 1]
        accepted = image == os.environ['ECHO_TEST_ACCEPTED_IMAGE']
        if not accepted and (root / 'fail-candidate-verify').exists(): raise SystemExit(1)
        # This fixture rehearses the historical V5 -> V6 images. The current
        # product initializes its current schema and rejects both old versions.
        # Execute the complete verifier with each historical image's baseline
        # pin; never relax the current product verifier for these test images.
        if os.environ.get('ECHO_TEST_MIGRATION_FROM') == '8' and not accepted:
            # The V9 candidate executes its actual complete verifier and
            # immutable processor-admission check, without replacing any pin.
            script = script.replace('/echo-clean/state', state)
            raise SystemExit(execute_node(script))
        source = pathlib.Path('packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js').resolve()
        historical_version = os.environ.get('ECHO_TEST_MIGRATION_FROM', '5') if accepted else '6'
        script, replacements = re.subn(
            r'\b(AUTHORITY_BASELINE_SCHEMA_VERSION_V|authorityBaselineSha256V)\d+\b',
            lambda match: match.group(1) + historical_version,
            source.read_text(),
        )
        assert replacements == 4, 'historical verifier must replace both baseline imports and uses'
        script = script.replace('"../', '"' + str(source.parent.parent) + '/')
        script += '\nverifyAuthorityStateLineage(' + repr(state) + ');'
    raise SystemExit(execute_node(script))
os.execv(str(root / 'bin/docker-fallback'), [str(root / 'bin/docker-fallback'), *args])
