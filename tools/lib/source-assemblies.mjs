import { posix } from 'node:path';
import { swiftSourceAssemblyV1 } from './swift-source-assembly.mjs';
import { textFile } from './repository-files.mjs';

export function javascriptSourceAssemblyV1(value) {
  const keys = ['schema_version', 'kind', 'entrypoint', 'neutral_sources', 'provider_assets'];
  if (!value || value.schema_version !== 1 || value.kind !== 'echo-javascript-source-assembly' ||
      Object.keys(value).some(key => !keys.includes(key)) || !Array.isArray(value.neutral_sources) ||
      !Array.isArray(value.provider_assets)) throw new Error('invalid JavaScript source assembly');
  const sources = [value.entrypoint, ...value.neutral_sources, ...value.provider_assets];
  for (const path of sources) {
    if (typeof path !== 'string' || path.startsWith('/') || path.startsWith('../') ||
        posix.normalize(path) !== path || path.includes('\\')) throw new Error('invalid assembly input');
  }
  if (new Set(sources).size !== sources.length || !value.entrypoint.endsWith('.mjs') ||
      value.neutral_sources.some(path => !path.endsWith('.mjs')) ||
      value.provider_assets.some(path => !path.endsWith('.json'))) throw new Error('invalid or duplicate assembly input');
  return Object.freeze({ ...value, sources: Object.freeze(sources) });
}

/** Native and deployment builders share these exact, finite inputs with the single boundary gate. */
export function sourceAssemblyOwners(tree, paths, providerRoots, manifests, errors) {
  const owners = new Map();
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length) {
    errors.push('source assemblies must be a unique explicit list');
    return owners;
  }
  for (const path of paths) {
    try {
      const value = JSON.parse(textFile(tree, path));
      const swift = value?.kind === 'echo-swift-source-assembly';
      const assembly = swift ? swiftSourceAssemblyV1(value) : javascriptSourceAssemblyV1(value);
      const roles = swift ? [
        ['bootstrap', assembly.bootstrap_sources], ['neutral', assembly.neutral_sources], ['provider', assembly.provider_sources],
      ] : [['bootstrap', [assembly.entrypoint]], ['neutral', assembly.neutral_sources], ['provider', assembly.provider_assets]];
      for (const [kind, sources] of roles) for (const source of sources) {
        if (!tree.has(source)) errors.push(`assembly input is missing: ${source}`);
        const provider = providerRoots.find(root => source.startsWith(`${root}/`));
        if ((kind === 'provider') !== Boolean(provider)) errors.push(`assembly input has the wrong provider owner: ${source}`);
        if (kind !== 'provider' && !source.startsWith(`${posix.dirname(path)}/`)) {
          errors.push(`neutral assembly input escapes its owner: ${source}`);
        }
        const previous = owners.get(source);
        if (previous && (previous.kind !== kind || previous.provider !== provider)) errors.push(`assembly input has conflicting owners: ${source}`);
        if (kind === 'provider' && !swift && !manifests.some(manifest => manifest.runtime_assets?.includes(source))) {
          errors.push(`provider assembly asset is not a declared runtime asset: ${source}`);
        }
        owners.set(source, { kind, provider, manifest: { name: path, boundary_root: posix.dirname(path) } });
      }
    } catch (error) { errors.push(`invalid source assembly ${path}: ${error.message}`); }
  }
  for (const path of tree.keys()) {
    if ((path.startsWith('product/') || path.startsWith('providers/')) && path.endsWith('.swift') && !owners.has(path)) {
      errors.push(`Swift source has no assembly owner: ${path}`);
    }
    if (path.endsWith('-assembly.v1.json') && !paths.includes(path)) errors.push(`source assembly is not registered: ${path}`);
  }
  return owners;
}
