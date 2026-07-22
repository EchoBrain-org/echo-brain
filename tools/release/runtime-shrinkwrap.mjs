function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLockedDependency(packages, fromPath, dependency) {
  let current = fromPath;
  for (;;) {
    const candidate = current
      ? `${current}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (packages[candidate] !== undefined) return candidate;
    if (current === "") break;
    const nestedAt = current.lastIndexOf("/node_modules/");
    current = nestedAt === -1 ? "" : current.slice(0, nestedAt);
  }
  throw new Error(
    `root lock does not resolve '${dependency}' from '${fromPath || "<root>"}'`,
  );
}

function assertExactBundledWorkspacePackages(template, expectedPackages) {
  const declared = template.bundleDependencies;
  if (
    !Array.isArray(declared) ||
    declared.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error(
      "runtime package template must declare bundleDependencies as package names",
    );
  }
  if (new Set(declared).size !== declared.length) {
    throw new Error(
      "runtime package template bundleDependencies must not contain duplicates",
    );
  }
  if (
    !Array.isArray(expectedPackages) ||
    expectedPackages.length === 0 ||
    expectedPackages.some(
      (name) => typeof name !== "string" || name.length === 0,
    ) ||
    new Set(expectedPackages).size !== expectedPackages.length
  ) {
    throw new Error("expected bundled workspace packages are invalid");
  }
  const expected = [...expectedPackages].sort();
  const actual = [...declared].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `runtime bundleDependencies must be exactly: ${expectedPackages.join(", ")}`,
    );
  }
  for (const dependency of declared) {
    if (typeof template.dependencies?.[dependency] !== "string") {
      throw new Error(
        `bundled workspace package must be a runtime dependency: ${dependency}`,
      );
    }
  }
  return declared;
}

function bundledWorkspaceMetadata(packages, dependency, expectedVersion) {
  const installPath = resolveLockedDependency(packages, "", dependency);
  const link = packages[installPath];
  if (link?.link !== true || typeof link.resolved !== "string") {
    throw new Error(
      `bundled workspace package is not a root lock workspace link: ${dependency}`,
    );
  }
  if (
    link.resolved.startsWith("/") ||
    link.resolved.split("/").includes("..")
  ) {
    throw new Error(
      `bundled workspace package has an unsafe lock target: ${dependency}`,
    );
  }
  const source = packages[link.resolved];
  if (
    !isRecord(source) ||
    source.name !== dependency ||
    typeof source.version !== "string"
  ) {
    throw new Error(
      `root lock is missing workspace metadata for bundled package: ${dependency}`,
    );
  }
  if (source.version !== expectedVersion) {
    throw new Error(
      `bundled workspace version mismatch for ${dependency}: template=${expectedVersion} lock=${source.version}`,
    );
  }

  const metadata = { version: source.version };
  for (const field of [
    "license",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "engines",
    "os",
    "cpu",
  ]) {
    if (source[field] !== undefined) metadata[field] = source[field];
  }
  metadata.inBundle = true;
  return { installPath, sourcePath: link.resolved, metadata };
}

/**
 * Derive one runtime-only npm shrinkwrap from the repository's authoritative
 * lock. Workspace links named in the exact bundle allowlist become immutable
 * in-bundle entries; every other runtime dependency retains registry integrity.
 */
export function runtimeShrinkwrap(
  template,
  rootLock,
  { bundledWorkspacePackages },
) {
  if (
    rootLock?.lockfileVersion !== 3 ||
    !isRecord(rootLock.packages) ||
    !isRecord(rootLock.packages[""])
  ) {
    throw new Error("root npm-shrinkwrap.json must use lockfileVersion 3");
  }
  if (
    !isRecord(template) ||
    typeof template.name !== "string" ||
    typeof template.version !== "string" ||
    !isRecord(template.dependencies)
  ) {
    throw new Error("runtime package template is invalid");
  }

  const packages = rootLock.packages;
  const bundled = assertExactBundledWorkspacePackages(
    template,
    bundledWorkspacePackages,
  );
  const bundledSet = new Set(bundled);
  const bundleEntries = new Map();
  const selected = new Set();
  const queue = [];

  for (const dependency of Object.keys(template.dependencies).sort()) {
    if (!bundledSet.has(dependency)) {
      queue.push(resolveLockedDependency(packages, "", dependency));
      continue;
    }
    const workspace = bundledWorkspaceMetadata(
      packages,
      dependency,
      template.dependencies[dependency],
    );
    bundleEntries.set(workspace.installPath, workspace.metadata);
    for (const transitive of [
      ...Object.keys(workspace.metadata.dependencies ?? {}),
      ...Object.keys(workspace.metadata.optionalDependencies ?? {}),
    ].sort()) {
      if (!bundledSet.has(transitive)) {
        queue.push(
          resolveLockedDependency(packages, workspace.sourcePath, transitive),
        );
      }
    }
  }

  while (queue.length > 0) {
    const path = queue.shift();
    if (selected.has(path)) continue;
    selected.add(path);
    const metadata = packages[path];
    if (!isRecord(metadata)) {
      throw new Error(`root lock is missing '${path}'`);
    }
    if (metadata.link === true) {
      throw new Error(
        `unbundled workspace link entered the runtime dependency closure: ${path}`,
      );
    }
    for (const dependency of [
      ...Object.keys(metadata.dependencies ?? {}),
      ...Object.keys(metadata.optionalDependencies ?? {}),
    ].sort()) {
      queue.push(resolveLockedDependency(packages, path, dependency));
    }
  }

  const rootMetadata = {
    name: template.name,
    version: template.version,
    license: template.license,
    dependencies: template.dependencies,
    bundleDependencies: bundled,
    bin: template.bin,
    engines: template.engines,
  };
  for (const key of Object.keys(rootMetadata)) {
    if (rootMetadata[key] === undefined) delete rootMetadata[key];
  }

  const packageEntries = { "": rootMetadata };
  for (const [path, metadata] of [...bundleEntries].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    packageEntries[path] = metadata;
  }
  for (const path of [...selected].sort()) {
    packageEntries[path] = packages[path];
  }
  return {
    name: template.name,
    version: template.version,
    lockfileVersion: 3,
    requires: true,
    packages: packageEntries,
  };
}
