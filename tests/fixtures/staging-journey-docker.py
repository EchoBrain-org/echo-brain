"""Explicit container-engine simulator, never invokes Docker or AWS.

Unknown operations fail closed. Runtime identity has independent durable state;
the updater cannot make a check pass merely by editing its environment file.
Node verification, setup status, descriptor checks and canary are real processes.
"""
import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
assert (root / 'fixture-owner').read_text() == 'staging-journey-v1\n'
config = json.loads((root / 'fixture-engine.json').read_text())
args = sys.argv[2:]
engine_path = root / 'engine-state.json'
engine = json.loads(engine_path.read_text())
with (root / 'engine-calls.jsonl').open('a') as output:
    output.write(json.dumps(args) + '\n')


def finish(value=None):
    if value is not None:
        print(value)
    raise SystemExit(0)


def bridge(mode, *extra):
    result = subprocess.run([config['node'], config['runtime_fixture'], mode, str(root), *extra])
    raise SystemExit(result.returncode)


if args[0] == 'pull' and args[1] in config['images']:
    finish()
if args[0] == 'run' and '--network' in args and args[args.index('--network') + 1] == 'none' and '--read-only' in args:
    assert any(image in args for image in config['images'])
    assert 'verifyPersistedOpenRouterDecisionProcessorAdmissionV1' in args[-1]
    bridge('verify')
if args[0] == 'compose':
    assert args[1:3] == ['--env-file', str(root / 'host/.env.clean-v1')]
    assert args[3:7] == ['-f', str(root / 'host/compose.clean-v1.yaml'), '-f', str(root / 'host/compose.clean-v1.ec2.yaml')]
    operation = args[7:]
    if operation[:2] == ['ps', '-q'] and operation[2] in ('authority', 'proxy'):
        finish(operation[2] + '-fixture' if engine['running'] else '')
    if operation == ['pull', 'authority'] or operation == ['restart', 'proxy']:
        finish()
    if operation[:2] == ['up', '-d'] and '--no-build' in operation:
        environment = dict(line.split('=', 1) for line in (root / 'host/.env.clean-v1').read_text().splitlines() if line and not line.startswith('#'))
        assert environment['ECHO_CLEAN_AUTHORITY_IMAGE'] in config['images']
        engine = {'running': True, 'environment': environment}
        engine_path.write_text(json.dumps(engine))
        finish()
    if operation == ['down']:
        engine['running'] = False
        engine_path.write_text(json.dumps(engine))
        finish()
    if operation[:4] == ['exec', '-T', 'authority', 'node']:
        assert engine['running']
        command = operation[4:]
        if command[0].endswith('/clean-live-main.js') and command[1:3] == ['staging-private-dm-canary', '--release-id']:
            assert command[3] == engine['environment']['ECHO_CLEAN_RELEASE_ID']
            bridge('client', command[3])
        if command[0].endswith('/clean-founder-main.js') and command[1:] == ['status', '--state-dir', '/echo-clean/state']:
            bridge('setup-status')
        if command[0] == '-e' and '/v1/authority-descriptor' in command[1]:
            result = subprocess.run([config['node'], '--import', config['fetch_fixture'], *command], env={**os.environ, 'ECHO_JOURNEY_ROOT': str(root)})
            raise SystemExit(result.returncode)
if args[0] == 'inspect' or args[:2] == ['image', 'inspect']:
    fmt = args[args.index('--format') + 1]
    image_lookup = args[0] == 'image'
    reference = args[-1]
    if not image_lookup:
        assert reference in ('authority-fixture', 'proxy-fixture')
        image = config['images'][engine['environment']['ECHO_CLEAN_AUTHORITY_IMAGE']]
    else:
        image = config['images'].get(reference) or next((item for item in config['images'].values() if item['id'] == reference), None)
        assert image is not None
    if fmt == '{{.State.Running}}': finish(str(engine['running']).lower())
    if fmt == '{{.Image}}': finish(image['id'])
    if fmt == '{{range .RepoDigests}}{{println .}}{{end}}': finish(image['reference'])
    if 'org.opencontainers.image.revision' in fmt: finish(image['source'])
    if 'io.echo-brain.release-id' in fmt: finish(engine['environment']['ECHO_CLEAN_RELEASE_ID'])
    if 'io.echo-brain.runtime-profile-sha256' in fmt: finish(engine['environment']['ECHO_CLEAN_RUNTIME_PROFILE_SHA256'])
    if 'org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1' in fmt: finish('true')
    if 'org.echobrain.authority.telemetry.staging-journey-v1' in fmt: finish('true')
    if 'org.echobrain.authority.build-number' in fmt: finish('1')
    if fmt == '{{json .Config.Env}}':
        values = ['ECHO_SOURCE_SHA=' + image['source'], 'ECHO_BUILD_NUMBER=1', 'ECHO_STAGING_JOURNEY_TELEMETRY_V1=true']
        if not image_lookup:
            values += [name + '=' + value for name, value in engine['environment'].items() if name == 'ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1']
        finish(json.dumps(values))
raise SystemExit('unexpected simulated container operation: ' + repr(args))
