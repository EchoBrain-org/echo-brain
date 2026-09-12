import { sourceAssemblyOwners } from './source-assemblies.mjs';
import { textFile } from './repository-files.mjs';
import { providerModuleGraph } from './provider-module-graph.mjs';

const MODULE = /\.[cm]?[jt]sx?$/;
const TEST = /(?:^|\/)(?:tests?|__tests__)\//;
const within = (path, root) => path === root || path.startsWith(`${root}/`);

/** Ownership and inward dependency direction are independent of provider names in source text. */
export function checkProviderOwnership(tree, architecture, resolveRelative, errors) {
  if (!architecture || architecture.ownership_version !== 1 ||
      !Array.isArray(architecture.provider_roots) ||
      !Array.isArray(architecture.bootstrap_entrypoints)) {
    errors.push('provider architecture requires versioned ownership and bootstrap declarations');
    return null;
  }
  const accepted = new Set(['ownership_version', 'provider_roots', 'bootstrap_entrypoints', 'source_assemblies']);
  for (const key of Object.keys(architecture)) if (!accepted.has(key)) {
    errors.push(`provider architecture field is unsupported or retired: ${key}`);
  }
  const providerRoots = architecture.provider_roots;
  const bootstrap = new Set(architecture.bootstrap_entrypoints);
  if (providerRoots.length !== new Set(providerRoots).size || bootstrap.size !== architecture.bootstrap_entrypoints.length) {
    errors.push('provider ownership declarations must be unique');
  }
  for (const root of providerRoots) if (typeof root !== 'string' || !/^providers\/[a-z][a-z0-9-]*$/.test(root)) {
    errors.push(`provider must have one repository-root folder: ${root}`);
  }
  const registry = JSON.parse(textFile(tree, 'tools/workspace-source-boundaries.v1.json'));
  const manifests = registry.manifests.map(path => JSON.parse(textFile(tree, path)));
  const graph = providerModuleGraph(tree, resolveRelative, errors);
  const assemblies = sourceAssemblyOwners(tree, architecture.source_assemblies, providerRoots, manifests, errors, graph.resolve);
  const workspace = path => manifests.find(manifest => within(path, manifest.source_root) || manifest.runtime_assets?.includes(path) || path === manifest.package_json);
  const provider = path => providerRoots.find(root => within(path, root));
  const production = [...tree.keys()].filter(path => {
    if (!MODULE.test(path)) return false;
    if (assemblies.has(path)) return true;
    // A test-named folder inside shipped source is still production source.
    if (workspace(path)) return true;
    if (TEST.test(path)) return false;
    if (manifests.some(manifest => path === `${manifest.boundary_root}/vitest.config.ts`)) return false;
    return ['packages', 'services', 'src', 'providers'].some(root => within(path, root));
  });
  for (const root of providerRoots) if (!production.some(path => within(path, root))) {
    errors.push(`provider root has no implementation: ${root}`);
  }
  for (const path of bootstrap) if (!tree.has(path) || !production.includes(path) || provider(path)) {
    errors.push(`bootstrap entrypoint must name a composing source module: ${path}`);
  }
  const owner = path => {
    const manifest = workspace(path);
    if (!manifest) return assemblies.get(path) ?? null;
    if (bootstrap.has(path)) return { kind: 'bootstrap', manifest };
    const root = provider(path);
    if (root) return { kind: 'provider', provider: root, manifest };
    if (within(path, 'providers')) return null;
    return { kind: 'neutral', manifest };
  };
  const edges = [];
  const workspaceEdges = new Map();
  for (const path of production) {
    const from = owner(path);
    if (!from) { errors.push(`production module has no architecture owner: ${path}`); continue; }
    for (const target of graph.targets(path)) {
      // Runtime asset edges obey the same provider direction as source modules.
      const to = owner(target);
      edges.push([path, target]);
      if (!to) { errors.push(`production dependency has no architecture owner: ${path} -> ${target}`); continue; }
      if (from.kind === 'neutral' && to.kind !== 'neutral') {
        errors.push(`neutral module reaches ${to.kind}: ${path} -> ${target}`);
      }
      if (within(from.manifest.boundary_root, 'packages') && (within(target, 'services') || within(target, 'src/product'))) {
        errors.push(`neutral library imports a composing application: ${path} -> ${target}`);
      }
      if (from.kind === 'provider' && (to.kind === 'bootstrap' || within(target, 'services'))) {
        errors.push(`provider imports the composing service: ${path} -> ${target}`);
      }
      if (from.kind === 'provider' && to.kind === 'provider' && from.provider !== to.provider) {
        errors.push(`cross-provider dependency: ${path} -> ${target}`);
      }
      if (from.manifest.name !== to.manifest.name) {
        if (!workspaceEdges.has(from.manifest.name)) workspaceEdges.set(from.manifest.name, new Set());
        workspaceEdges.get(from.manifest.name).add(to.manifest.name);
      }
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
    production_modules: production.length,
    module_edges: edges.length,
    workspace_edges: [...workspaceEdges.values()].reduce((count, targets) => count + targets.size, 0),
    workspace_cycles: cycles,
    bootstrap_entrypoints: [...bootstrap].sort(),
    source_assemblies: architecture.source_assemblies,
    assembly_inputs: assemblies.size,
    exceptions: 0,
  };
}
