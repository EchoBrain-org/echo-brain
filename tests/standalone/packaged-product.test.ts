import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'echo-brain-package-'));
const artifactDirectory = join(temporaryRoot, 'artifact');
const npmCli = realpathSync(join(dirname(process.execPath), 'npm'));
const npmEnvironment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  npm_config_cache: join(REPO, '.npm-cache'),
};
let artifactPath: string;

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

beforeAll(() => {
  mkdirSync(artifactDirectory, { recursive: true });
  const packed = run(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', artifactDirectory],
    { env: npmEnvironment },
  );
  expect(packed.status, packed.stdout + packed.stderr).toBe(0);
  const report = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  expect(report).toHaveLength(1);
  artifactPath = join(artifactDirectory, report[0]!.filename);
  expect(existsSync(artifactPath)).toBe(true);
}, 180_000);

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('ordinary npm package', () => {
  it('contains the CLI, public schema, SQLite migrations, adapters, license, and metadata', () => {
    const listed = run('/usr/bin/tar', ['-tzf', artifactPath], {
      cwd: temporaryRoot,
    });
    expect(listed.status, listed.stderr).toBe(0);
    const members = new Set(listed.stdout.trim().split('\n'));
    for (const required of [
      'package/dist/product/cli.js',
      'package/dist/product/index.js',
      'package/dist/product/index.d.ts',
      'package/dist/product/build-identity.v1.json',
      'package/dist/product/federation/cutover-fence.js',
      'package/dist/product/federation/cutover-fence.d.ts',
      'package/dist/product/federation/independent-copy-store.js',
      'package/dist/product/federation/independent-copy-store.d.ts',
      'package/dist/product/federation/legacy-classification.js',
      'package/dist/product/federation/legacy-classification.d.ts',
      'package/dist/core/index.js',
      'package/dist/core/index.d.ts',
      'package/dist/adapters/meeting-sources/granola/index.js',
      'package/dist/adapters/meeting-sources/granola/granola-api-client.js',
      'package/dist/adapters/meeting-sources/granola/meeting-source-adapter.js',
      'package/dist/adapters/decision-processors/structured-text/index.js',
      'package/dist/adapters/decision-processors/llm/index.js',
      'package/dist/adapters/decision-processors/llm/llm-decision-processor.js',
      'package/dist/adapters/delivery-surfaces/jsonl-outbox/index.js',
      'package/dist/adapters/delivery-surfaces/slack/index.js',
      'package/dist/adapters/delivery-surfaces/slack/slack-delivery-surface.js',
      'package/dist/adapters/delivery-surfaces/slack/slack-delivery-receipt-store.js',
      'package/dist/adapters/shared/slack/slack-web-api-client.js',
      'package/dist/infrastructure/filesystem/atomic-write.js',
      'package/dist/infrastructure/sqlite/migrate.js',
      'package/dist/product/storage/open-product-database.js',
      'package/dist/product/storage/sqlite-core-state-store.js',
      'package/dist/product/storage/migrations/0001_initial.sql',
      'package/dist/product/storage/migrations/0002_core_state.sql',
      'package/dist/product/storage/migrations/0003_federated_founder_identity.sql',
      'package/dist/product/storage/migrations/0004_remove_legacy_events.sql',
      'package/schemas/meeting-context.v1.schema.json',
      'package/schemas/runtime-config.v1.schema.json',
      'package/schemas/product/active-identity-bundle.v1.schema.json',
      'package/schemas/product/local-identity-manifest.v1.schema.json',
      'package/schemas/product/local-connection-registry.v1.schema.json',
      'package/schemas/product/publication-policy.v1.schema.json',
      'package/schemas/product/source-attribution.v1.schema.json',
      'package/schemas/product/processor-attribution.v1.schema.json',
      'package/schemas/product/approval-federation-metadata.v1.schema.json',
      'package/schemas/product/federated-record-envelope.v1.schema.json',
      'package/schemas/product/federated-export.v1.schema.json',
      'package/schemas/product/federated-recovery-report.v1.schema.json',
      'package/docs/architecture/core-and-adapters.md',
      'package/LICENSE',
      'package/README.md',
      'package/package.json',
      'package/npm-shrinkwrap.json',
    ]) {
      expect(members.has(required), `missing package member ${required}`).toBe(
        true,
      );
    }
    expect(
      [...members].some((member) => member.startsWith('package/dist/capture/')),
    ).toBe(false);
    expect(
      [...members].some((member) =>
        member.startsWith('package/dist/echo-home/'),
      ),
    ).toBe(false);
    expect(
      [...members].some((member) => member.startsWith('package/dist/enrich/')),
    ).toBe(false);
    expect(
      [...members].some((member) => member.includes('/granola/compatibility/')),
    ).toBe(false);
    expect(
      [...members].some((member) =>
        member.startsWith('package/dist/adapters/communication-channels/'),
      ),
    ).toBe(false);
    const digest = createHash('sha256')
      .update(readFileSync(artifactPath))
      .digest('hex');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('installs the tarball, runs the CLI smokes, and opens migrated SQLite', () => {
    const prefix = join(temporaryRoot, 'installed-prefix');
    mkdirSync(prefix, { recursive: true });
    const packageManifest = JSON.parse(
      readFileSync(join(REPO, 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      license: string;
      dependencies: Record<string, string>;
      bin: Record<string, string>;
      engines: Record<string, string>;
    };
    const shrinkwrap = JSON.parse(
      readFileSync(join(REPO, 'npm-shrinkwrap.json'), 'utf8'),
    ) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const artifactSpec = `file:${artifactPath}`;
    writeFileSync(
      join(prefix, 'package.json'),
      `${JSON.stringify(
        {
          name: 'echo-brain-install-smoke',
          version: '1.0.0',
          private: true,
          dependencies: { [packageManifest.name]: artifactSpec },
        },
        null,
        2,
      )}\n`,
    );
    const { '': _sourceRoot, ...lockedPackages } = shrinkwrap.packages;
    writeFileSync(
      join(prefix, 'package-lock.json'),
      `${JSON.stringify(
        {
          name: 'echo-brain-install-smoke',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'echo-brain-install-smoke',
              version: '1.0.0',
              dependencies: { [packageManifest.name]: artifactSpec },
            },
            ...lockedPackages,
            'node_modules/echo-brain': {
              version: packageManifest.version,
              resolved: artifactSpec,
              integrity: `sha512-${createHash('sha512').update(readFileSync(artifactPath)).digest('base64')}`,
              license: packageManifest.license,
              dependencies: packageManifest.dependencies,
              bin: packageManifest.bin,
              engines: packageManifest.engines,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const installed = run(
      process.execPath,
      [npmCli, 'ci', '--offline', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: prefix, env: { ...npmEnvironment, npm_config_offline: 'true' } },
    );
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const configPath = join(temporaryRoot, 'runtime-config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          lane: 'team-product',
          state_dir: join(temporaryRoot, 'state'),
          meeting_sources: [
            {
              adapter_id: 'fixture-meetings',
              instance_id: 'primary',
              settings: {},
            },
          ],
          decision_processor: {
            adapter_id: 'fixture-processor',
            instance_id: 'primary',
            settings: {},
          },
          delivery_surfaces: [
            {
              adapter_id: 'fixture-delivery',
              instance_id: 'team',
              settings: {},
            },
          ],
          approval_mode: 'manual',
        },
        null,
        2,
      )}\n`,
    );

    const cli = join(
      prefix,
      'node_modules',
      'echo-brain',
      'dist',
      'product',
      'cli.js',
    );
    const validated = run(
      process.execPath,
      [cli, 'validate-config', '--config', configPath],
      { cwd: prefix },
    );
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      ok: true,
      command: 'validate-config',
      lane: 'team-product',
    });

    const selftest = run(
      process.execPath,
      [cli, 'selftest', '--config', configPath],
      { cwd: prefix },
    );
    expect(selftest.status, selftest.stderr).toBe(0);
    expect(JSON.parse(selftest.stdout)).toMatchObject({
      ok: true,
      command: 'selftest',
      maturity: 'DEV',
      adapter_references: {
        meeting_sources: [
          { adapter_id: 'fixture-meetings', instance_id: 'primary' },
        ],
        decision_processor: {
          adapter_id: 'fixture-processor',
          instance_id: 'primary',
        },
        delivery_surfaces: [
          { adapter_id: 'fixture-delivery', instance_id: 'team' },
        ],
      },
      wedge_executed: false,
    });

    const modulePath = join(
      prefix,
      'node_modules',
      'echo-brain',
      'dist',
      'product',
      'index.js',
    );
    const productStorageSmoke = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import { pathToFileURL } from 'node:url';",
          'const product = await import(pathToFileURL(process.argv[1]).href);',
          "const storage = new product.SqliteCoreStateStore(':memory:');",
          'storage.close();',
          "console.log(JSON.stringify({ ok: typeof product.SqliteStorage === 'undefined' }));",
        ].join('\n'),
        modulePath,
      ],
      { cwd: prefix },
    );
    expect(productStorageSmoke.status, productStorageSmoke.stderr).toBe(0);
    expect(JSON.parse(productStorageSmoke.stdout)).toEqual({ ok: true });

    const coreSmoke = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "const core = await import('echo-brain/core');",
          "const adapters = await import('echo-brain/adapters');",
          "const granola = await import('echo-brain/adapters/meeting-sources/granola');",
          "const processor = await import('echo-brain/adapters/decision-processors/structured-text');",
          "const llm = await import('echo-brain/adapters/decision-processors/llm');",
          "const surface = await import('echo-brain/adapters/delivery-surfaces/jsonl-outbox');",
          "const slackSurface = await import('echo-brain/adapters/delivery-surfaces/slack');",
          'const registry = new core.AdapterRegistry();',
          'console.log(JSON.stringify({',
          "  ok: typeof registry.get === 'function' &&",
          "    typeof adapters.decisionProcessors.LlmDecisionProcessor === 'function' &&",
          "    typeof granola.GranolaMeetingSourceAdapter === 'function' &&",
          "    typeof granola.HttpGranolaApiClient === 'function' &&",
          "    typeof processor.StructuredTextDecisionProcessor === 'function' &&",
          "    typeof llm.LlmDecisionProcessor === 'function' &&",
          "    typeof llm.OllamaClient === 'function' &&",
          "    typeof surface.JsonlOutboxDeliverySurface === 'function' &&",
          "    typeof slackSurface.SlackDeliverySurface === 'function' &&",
          "    typeof slackSurface.FileSlackDeliveryReceiptStore === 'function'",
          '}));',
        ].join('\n'),
      ],
      { cwd: prefix },
    );
    expect(coreSmoke.status, coreSmoke.stderr).toBe(0);
    expect(JSON.parse(coreSmoke.stdout)).toEqual({ ok: true });
  }, 180_000);
});
