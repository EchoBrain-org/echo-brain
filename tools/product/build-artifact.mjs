#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { PRODUCT_BUNDLED_WORKSPACE_PACKAGES } from './sync-shrinkwrap.mjs';
import {
  ARTIFACT_BUNDLED_WORKSPACES,
  REPO_ROOT,
  assertPackageHasNoBuildPaths,
  copyRequired,
  filesUnder,
  gitOutput,
  isolatedNpmEnvironment,
  linkMaterializedBuildDependencies,
  materializeCommit,
  parseArgs,
  parseSinglePackResult,
  readJson,
  run,
  safeRemoveTemporary,
  sha256File,
  stageBundledWorkspaces,
  waitAtTestPreflightCheckpoint,
} from '../release/artifact-builder.mjs';

function assertExactBundleContract(template) {
  const expected = [...PRODUCT_BUNDLED_WORKSPACE_PACKAGES];
  const staged = ARTIFACT_BUNDLED_WORKSPACES.map(({ name }) => name);
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    throw new Error(
      'artifact workspace staging and product shrinkwrap bundle contracts differ',
    );
  }
  if (
    JSON.stringify(template.bundleDependencies) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `product bundleDependencies must be exactly: ${expected.join(', ')}`,
    );
  }
}

function buildBundledWorkspaces(source) {
  run(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules/typescript/bin/tsc'),
      '-b',
      ...ARTIFACT_BUNDLED_WORKSPACES.map(({ directory }) => join(source, directory)),
    ],
    { cwd: source },
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const sourceSha = args['source-sha'].toLowerCase();
  const outDir = resolve(args['out-dir']);
  const head = gitOutput(['rev-parse', 'HEAD']).toLowerCase();
  if (head !== sourceSha) {
    throw new Error(`source SHA mismatch: HEAD=${head} supplied=${sourceSha}`);
  }
  if (existsSync(outDir))
    throw new Error(`--out-dir already exists: ${outDir}`);

  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(outDir)}.build-`));
  const work = join(temporary, 'work');
  const source = join(work, 'source');
  const packageDir = join(work, 'package');
  try {
    mkdirSync(work, { recursive: true });
    materializeCommit(sourceSha, source, join(work, 'source.tar'));
    linkMaterializedBuildDependencies(source);

    run(process.execPath, ['tools/product/sync-shrinkwrap.mjs', '--check'], {
      cwd: source,
    });
    const closurePath = join(work, 'closure.json');
    run(
      process.execPath,
      [
        'tools/product/check-boundary.mjs',
        '--project-root',
        source,
        '--output',
        closurePath,
      ],
      { cwd: source },
    );
    const closure = readJson(closurePath);
    waitAtTestPreflightCheckpoint({
      readyEnvVar: 'PRODUCT_BUILD_TEST_PREFLIGHT_READY_FILE',
      resumeEnvVar: 'PRODUCT_BUILD_TEST_CONTINUE_FILE',
      label: 'product',
    });
    buildBundledWorkspaces(source);

    mkdirSync(packageDir, { recursive: true });
    const buildConfigPath = join(work, 'tsconfig.product-build.json');
    writeFileSync(
      buildConfigPath,
      `${JSON.stringify(
        {
          extends: join(source, 'tsconfig.json'),
          compilerOptions: {
            outDir: join(packageDir, 'dist'),
            rootDir: join(source, 'src'),
            declaration: true,
            noEmit: false,
            incremental: false,
            tsBuildInfoFile: null,
            typeRoots: [join(source, 'node_modules/@types')],
            types: ['node'],
            baseUrl: source,
            paths: Object.fromEntries(
              ARTIFACT_BUNDLED_WORKSPACES.map(({ name, directory }) => [
                name,
                [`${directory}/dist/index.d.ts`],
              ]),
            ),
          },
          files: closure.closure.map((path) => join(source, path)),
          include: [],
          exclude: [],
        },
        null,
        2,
      )}\n`,
    );
    run(
      process.execPath,
      [
        join(source, 'node_modules/typescript/bin/tsc'),
        '--project',
        buildConfigPath,
      ],
      { cwd: source },
    );
    writeFileSync(
      join(packageDir, 'dist', 'product', 'build-identity.v1.json'),
      `${JSON.stringify({
        schema_version: 1,
        kind: 'echo-packaged-build-identity',
        product_version: version,
        source_sha: sourceSha,
        source_kind: 'materialized-commit',
      })}\n`,
    );

    for (const asset of closure.runtime_assets ?? []) {
      const destination = asset.startsWith('src/')
        ? join(packageDir, 'dist', asset.slice('src/'.length))
        : join(packageDir, asset);
      copyRequired(join(source, asset), destination, 'product package input');
    }
    copyRequired(
      join(source, 'product/README.md'),
      join(packageDir, 'README.md'),
      'product package input',
    );
    copyRequired(
      join(source, 'LICENSE'),
      join(packageDir, 'LICENSE'),
      'product package input',
    );

    const template = readJson(join(source, 'product/package.template.json'));
    assertExactBundleContract(template);
    const packageJson = { ...template, version };
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const committedShrinkwrapPath = join(source, 'npm-shrinkwrap.json');
    const packagedShrinkwrapPath = join(packageDir, 'npm-shrinkwrap.json');
    run(
      process.execPath,
      ['tools/product/sync-shrinkwrap.mjs', '--output', packagedShrinkwrapPath],
      { cwd: source },
    );
    const packagedShrinkwrap = readJson(packagedShrinkwrapPath);
    packagedShrinkwrap.version = version;
    packagedShrinkwrap.packages[''].version = version;
    writeFileSync(
      packagedShrinkwrapPath,
      `${JSON.stringify(packagedShrinkwrap, null, 2)}\n`,
    );
    stageBundledWorkspaces(source, packageDir, work);

    const packageFiles = filesUnder(packageDir);
    assertPackageHasNoBuildPaths(
      packageFiles,
      [REPO_ROOT, temporary, source],
      'product package file',
    );
    const packageEntries = packageFiles.map((path) => ({
      path: relative(packageDir, path).split(sep).join('/'),
      size: statSync(path).size,
      sha256: sha256File(path),
    }));

    const packOutput = run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      {
        cwd: packageDir,
        // npm pack does not need network or the user's ambient cache. Keep its
        // bookkeeping inside the disposable build root so read-only homes and
        // host-owned cache entries cannot affect an otherwise hermetic build.
        env: isolatedNpmEnvironment(join(work, 'npm-cache')),
      },
    );
    const packResult = parseSinglePackResult(packOutput, 'npm pack');
    const packedBundles = Array.isArray(packResult.bundled)
      ? [...packResult.bundled].sort()
      : [];
    const expectedBundles = [...PRODUCT_BUNDLED_WORKSPACE_PACKAGES].sort();
    if (JSON.stringify(packedBundles) !== JSON.stringify(expectedBundles)) {
      throw new Error(
        'npm pack did not bundle the exact product workspace package set',
      );
    }
    const packedPaths = packResult.files.map((entry) => entry.path).sort();
    if (
      JSON.stringify(packedPaths) !==
      JSON.stringify(packageEntries.map((entry) => entry.path))
    ) {
      throw new Error(
        'npm-packed file set differs from the staged product package',
      );
    }
    const tarballName = packResult.filename;
    const tarballPath = join(temporary, tarballName);
    if (!existsSync(tarballPath))
      throw new Error(`npm pack output is missing: ${tarballName}`);
    const tarballSha256 = sha256File(tarballPath);
    writeFileSync(
      join(temporary, `${tarballName}.sha256`),
      `${tarballSha256}  ${tarballName}\n`,
    );

    const manifest = {
      schema_version: 1,
      package: template.name,
      version,
      source_sha: sourceSha,
      product_boundary_version: closure.boundary_version,
      declared_platform: closure.phase_1_platform,
      dependency_lock_sha256: sha256File(committedShrinkwrapPath),
      packaged_shrinkwrap_sha256: sha256File(packagedShrinkwrapPath),
      build_command: [
        'node',
        'tools/product/build-artifact.mjs',
        '--version',
        version,
        '--source-sha',
        sourceSha,
        '--out-dir',
        outDir,
      ],
      artifact: {
        path: tarballName,
        size: statSync(tarballPath).size,
        sha256: tarballSha256,
      },
      package_files: packageEntries,
    };
    writeFileSync(
      join(temporary, 'artifact-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    safeRemoveTemporary(work, temporary);
    if (existsSync(outDir))
      throw new Error(`--out-dir appeared during build: ${outDir}`);
    renameSync(temporary, outDir);
    process.stdout.write(
      `${JSON.stringify({ ok: true, out_dir: outDir, artifact: tarballName, sha256: tarballSha256 })}\n`,
    );
  } catch (error) {
    if (existsSync(temporary)) safeRemoveTemporary(temporary, parent);
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`build-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
