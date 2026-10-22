import { textFile } from './repository-files.mjs';
import { providerModuleGraph } from './provider-module-graph.mjs';

const MODULE = /\.[cm]?[jt]sx?$/;
const TEST = /(?:^|\/)(?:tests?|__tests__)\//;
const within = (path, root) => path === root || path.startsWith(`${root}/`);

/** Ownership and inward dependency direction are independent of provider names in source text. */
export function checkProviderOwnership(tree, architecture, resolveRelative, errors) {
  if (!architecture || architecture.ownership_version !== 1 ||
      !Array.isArray(architecture.provider_roots) ||
      (architecture.shared_provider_roots !== undefined && !Array.isArray(architecture.shared_provider_roots)) ||
      !Array.isArray(architecture.bootstrap_entrypoints)) {
    errors.push('provider architecture requires versioned ownership and bootstrap declarations');
    return null;
  }
  const accepted = new Set(['ownership_version', 'provider_roots', 'shared_provider_roots', 'bootstrap_entrypoints']);
  for (const key of Object.keys(architecture)) if (!accepted.has(key)) {
    errors.push(`provider architecture field is unsupported or retired: ${key}`);
  }
  const providerRoots = architecture.provider_roots;
  const sharedProviderRoots = architecture.shared_provider_roots ?? [];
  const allProviderRoots = [...providerRoots, ...sharedProviderRoots];
  const bootstrap = new Set(architecture.bootstrap_entrypoints);
  if (allProviderRoots.length !== new Set(allProviderRoots).size || bootstrap.size !== architecture.bootstrap_entrypoints.length) {
    errors.push('provider ownership declarations must be unique');
  }
  for (const root of allProviderRoots) if (typeof root !== 'string' || !/^providers\/[a-z][a-z0-9-]*$/.test(root)) {
    errors.push(`provider must have one repository-root folder: ${root}`);
  }
  const registry = JSON.parse(textFile(tree, 'tools/workspace-source-boundaries.v1.json'));
  const manifests = registry.manifests.map(path => JSON.parse(textFile(tree, path)));
  const graph = providerModuleGraph(tree, resolveRelative, errors);
  // The Swift app is retired and nothing builds Swift, so any Swift source
  // under product/ or providers/ is unbuilt and unchecked.
  for (const path of tree.keys()) {
    if ((path.startsWith('product/') || path.startsWith('providers/')) && path.endsWith('.swift')) {
      errors.push(`Swift source is retired and has no builder: ${path}`);
    }
  }
  const workspace = path => manifests.find(manifest => within(path, manifest.source_root) || manifest.runtime_assets?.includes(path) || path === manifest.package_json);
  const provider = path => allProviderRoots.find(root => within(path, root));
  const production = [...tree.keys()].filter(path => {
    if (!MODULE.test(path)) return false;
    // A test-named folder inside shipped source is still production source.
    if (workspace(path)) return true;
    if (TEST.test(path)) return false;
    if (manifests.some(manifest => path === `${manifest.boundary_root}/vitest.config.ts`)) return false;
    return ['packages', 'services', 'src', 'providers'].some(root => within(path, root));
  });
  for (const root of allProviderRoots) if (!production.some(path => within(path, root))) {
    errors.push(`provider root has no implementation: ${root}`);
  }
  for (const path of bootstrap) if (!tree.has(path) || !production.includes(path) || provider(path)) {
    errors.push(`bootstrap entrypoint must name a composing source module: ${path}`);
  }
  const owner = path => {
    const manifest = workspace(path);
    if (!manifest) return null;
    if (bootstrap.has(path)) return { kind: 'bootstrap', manifest };
    const root = provider(path);
    if (root) return { kind: sharedProviderRoots.includes(root) ? 'shared-provider' : 'provider', provider: root, manifest };
    if (within(path, 'providers')) return null;
    return { kind: 'neutral', manifest };
  };
  const edges = [];
  const workspaceEdges = new Map();
  const checkEdge = (from, to, path, target) => {
    if (from.kind === 'neutral' && to.kind !== 'neutral') {
      errors.push(`neutral module reaches ${to.kind}: ${path} -> ${target}`);
    }
    if (within(from.manifest.boundary_root, 'packages') && (within(target, 'services') || within(target, 'src/product'))) {
      errors.push(`neutral library imports a composing application: ${path} -> ${target}`);
    }
    if ((from.kind === 'provider' || from.kind === 'shared-provider') && (to.kind === 'bootstrap' || within(target, 'services'))) {
      errors.push(`provider imports the composing service: ${path} -> ${target}`);
    }
    if ((from.kind === 'provider' || from.kind === 'shared-provider') && within(target, 'src/product')) {
      errors.push(`provider imports the composing application: ${path} -> ${target}`);
    }
    if (from.kind === 'shared-provider' && to.kind === 'provider') {
      errors.push(`shared provider library imports a concrete provider or application: ${path} -> ${target}`);
    }
    if (from.kind === 'provider' && to.kind === 'provider' && from.provider !== to.provider) {
      errors.push(`cross-provider dependency: ${path} -> ${target}`);
    }
    if (from.manifest.name !== to.manifest.name) {
      if (!workspaceEdges.has(from.manifest.name)) workspaceEdges.set(from.manifest.name, new Set());
      workspaceEdges.get(from.manifest.name).add(to.manifest.name);
    }
  };
  // Package dependencies determine install/build closure even when source no
  // longer imports them. Keep them subject to the same direction and cycle
  // rules, so an unused dependency cannot quietly reintroduce a retired edge.
  const workspaceByName = new Map(manifests.filter(manifest => manifest.workspace)
    .map(manifest => [manifest.name, manifest]));
  for (const manifest of workspaceByName.values()) {
    const path = manifest.package_json;
    const pkg = JSON.parse(textFile(tree, path));
    const from = owner(path);
    if (!from) continue;
    // Application manifests include the dependencies selected by their
    // bootstrap modules; ordinary modules still obey the finer source rules.
    if (within(manifest.boundary_root, 'services') || within(manifest.boundary_root, 'src/product')) {
      from.kind = 'bootstrap';
    }
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const target = workspaceByName.get(name)?.package_json;
      if (target === undefined) continue;
      const to = owner(target);
      if (to) checkEdge(from, to, path, target);
    }
  }
  for (const path of production) {
    const from = owner(path);
    if (!from) { errors.push(`production module has no architecture owner: ${path}`); continue; }
    for (const target of graph.targets(path)) {
      // Runtime asset edges obey the same provider direction as source modules.
      const to = owner(target);
      edges.push([path, target]);
      if (!to) { errors.push(`production dependency has no architecture owner: ${path} -> ${target}`); continue; }
      checkEdge(from, to, path, target);
    }
  }
  const visited = new Set(), active = new Set(), cycles = [];
  function visit(name, chain) {
    if (active.has(name)) { cycles.push([...chain, name]); return; }
    if (visited.has(name)) return;
    active.add(name);
    for (const next of workspaceEdges.get(name) ?? []) visit(next, [...chain, name]);
    active.delete(name); visited.add(name);
  }
  for (const name of workspaceEdges.keys()) visit(name, []);
  for (const cycle of cycles) errors.push(`workspace dependency cycle: ${cycle.join(' -> ')}`);
  return {
    provider_roots: [...providerRoots].sort(),
    shared_provider_roots: [...sharedProviderRoots].sort(),
    production_modules: production.length,
    module_edges: edges.length,
    workspace_edges: [...workspaceEdges.values()].reduce((count, targets) => count + targets.size, 0),
    workspace_cycles: cycles,
    bootstrap_entrypoints: [...bootstrap].sort(),
    exceptions: 0,
  };
}
