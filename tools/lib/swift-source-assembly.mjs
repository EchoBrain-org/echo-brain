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

/** Typecheck each allowed dependency set using only the materialized build inputs. */
export function checkSwiftSourceDirectionsV1(assembly, stagedSources, run, cwd) {
  if (stagedSources.length !== assembly.sources.length) throw new Error('Swift staged inputs do not match assembly');
  const staged = new Map(assembly.sources.map((source, index) => [source, stagedSources[index]]));
  const providers = new Map();
  for (const source of assembly.provider_sources) {
    const owner = source.match(/^providers\/[^/]+\//)?.[0];
    if (!owner) throw new Error(`Swift provider input has no provider root: ${source}`);
    if (!providers.has(owner)) providers.set(owner, []);
    providers.get(owner).push(source);
  }
  const groups = [['neutral', assembly.neutral_sources], ...[...providers].map(([owner, sources]) =>
    [owner, [...assembly.neutral_sources, ...sources]])];
  for (const [owner, sources] of groups) {
    if (!sources.length) continue;
    run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-warnings-as-errors',
      '-typecheck', '-module-name', 'EchoBoundary', '-target', 'arm64-apple-macos14.0',
      '-framework', 'AppKit', '-framework', 'Carbon', ...sources.map(source => staged.get(source))],
    `Swift dependency direction failed for ${owner}`, cwd);
  }
}
