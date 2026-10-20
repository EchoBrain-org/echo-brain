import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cache = fileURLToPath(new URL('.cache/unlimited/', import.meta.url));

/** Numeric maxima only; types, evidence/citation integrity and access rules remain. */
export function stripSizeBounds(value) {
  if (Array.isArray(value)) return value.map(stripSizeBounds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['maxItems', 'maxLength', 'maximum', 'exclusiveMaximum', 'maxProperties'].includes(k)).map(([k, v]) => [k, stripSizeBounds(v)]));
}

let loaded;
/** Build a disposable fork of the real renderer, never edit production source or compiled workspaces. */
export function unlimitedCore() {
  loaded ??= (async () => {
    await mkdir(cache, { recursive: true });
    const changes = [];
    const patch = (path, original) => {
      let text = original;
      const name = relative(root, path);
      const constants = (pattern) => { text = text.replace(pattern, '$1Infinity;'); };
      if (name.endsWith('agentic-ask-v1-model-protocol.ts')) {
        constants(/(const (?:AGENTIC_ASK_MAX_\w+|AGENTIC_ASK_LIST_LIMIT_MAX_V1|QUESTION_CHARS|NEED_CHARS|NEED_ID_CHARS|NOTES_CHARS|ARG_CHARS|SENTENCE_CHARS|NOT_FOUND_CHARS|SELECTION_CHARS|EVIDENCE_IDS_READ) = )[^;]+;/g);
        text = text.replace('const chars = [...value];', 'maximumChars = Infinity; const chars = [...value];');
        text = text.replace('> 1_000)', '> Infinity)');
        text = text.replace('Usually 2 to 6 sentences; use up to 10 when the question asks several things.', 'Use as many sentences as the question requires.');
        text = text.replaceAll('\\d{1,4}', '\\d+').replaceAll('\\d{1,3}', '\\d+');
      }
      if (name.endsWith('agentic-list-evidence-v1.ts')) {
        constants(/(const AGENTIC_LIST_(?:NAMED_MAX_V1|NAME_CHARS_V1|WRITER_LISTS_MAX_V1|WRITER_MEMBERS_MAX_V1|STATEMENT_BYTES_V1) = )[^;]+;/g);
        text = text.replace('function line(value: string, chars: number): string {', 'function line(value: string, chars: number): string { chars = Infinity;');
        text = text.replace('!Number.isSafeInteger(max_members)', '!(max_members === Infinity || Number.isSafeInteger(max_members))');
        text = text.replace(' || position > 9999', '').replaceAll('\\d{1,4}', '\\d+').replaceAll('\\d{0,3}', '\\d*');
      }
      if (name.endsWith('renderers/ask-renderer-v1.ts')) {
        text = text.replace('const MAX_CITATIONS = 40;', 'const MAX_CITATIONS = Infinity;').replace('.slice(0, 3);', '.slice(0);');
        text = text.replace('stats.calls === callsBefore + 1 && ', '');
      }
      if (name.endsWith('organization-api/src/person-answer-v4.ts')) {
        constants(/(const PERSON_(?:ANSWER_MAX_STATEMENTS_PER_PART_V4|ANSWER_RESPONSE_MAX_BYTES_V4|EVIDENCE_TEXT_MAX_BYTES_V1|EVIDENCE_RESPONSE_MAX_BYTES_V1|EVIDENCE_LABEL_MAX_BYTES_V1) = )[^;]+;/g);
        text = text.replace(/\.length > (40|5)/g, '.length > Infinity');
        text = text.replace(/, (?:4 \* 1024|2 \* 1024|1024)(?=[,)])/g, ', Infinity');
      }
      if (text !== original) changes.push({ file: name, original_sha256: createHash('sha256').update(original).digest('hex'), modified_sha256: createHash('sha256').update(text).digest('hex') });
      return text;
    };
    const outfile = resolve(cache, 'core.mjs');
    await build({ stdin: { contents: [
      "export { createAskRendererV1 } from './packages/organization-authority-kernel/src/answer-composition/renderers/ask-renderer-v1.ts';",
      "export { parseStep, ANSWER_PROMPT } from './packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1-model-protocol.ts';",
    ].join('\n'), resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
      alias: { '@echo-brain/organization-api': resolve(root, 'packages/organization-api/src/index.ts') },
      plugins: [{ name: 'synthetic-only-remove-size-caps', setup(b) {
        b.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ contents: patch(path, await readFile(path, 'utf8')), loader: 'ts', resolveDir: dirname(path) }));
      } }], logLevel: 'silent' });
    if (changes.length !== 4) throw new Error(`Expected four isolated cap patches, found ${changes.length}`);
    const manifest = { source: '819a9ef', changes, bundled_sha256: createHash('sha256').update(await readFile(outfile)).digest('hex') };
    await writeFile(resolve(cache, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { ...await import(pathToFileURL(outfile).href), manifest };
  })();
  return loaded;
}
