import { posix } from 'node:path';

/** The build and architecture gate consume the same finite Swift input manifest. */
export function swiftSourceAssemblyV1(value) {
  const fields = ['schema_version', 'kind', 'bootstrap_sources', 'neutral_sources', 'provider_sources'];
  if (!value || value.schema_version !== 1 || value.kind !== 'echo-swift-source-assembly' ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error('invalid Swift source assembly');
  const sources = [];
  for (const role of ['bootstrap_sources', 'neutral_sources', 'provider_sources']) {
    if (!Array.isArray(value[role])) throw new Error(`invalid Swift assembly ${role}`);
    for (const path of value[role]) {
      if (typeof path !== 'string' || !path.endsWith('.swift') || path.startsWith('/') || path.startsWith('../') ||
          posix.normalize(path) !== path || path.includes('\\') || sources.includes(path)) {
        throw new Error(`invalid or duplicate Swift assembly input: ${path}`);
      }
      sources.push(path);
    }
  }
  if (!value.bootstrap_sources.length || !sources.length) throw new Error('Swift assembly has no entrypoint');
  return Object.freeze({ ...value, sources: Object.freeze(sources) });
}
