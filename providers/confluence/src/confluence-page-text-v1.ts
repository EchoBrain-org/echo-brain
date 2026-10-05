import { normalizeAtlassianDocumentTextV1, splitAtlassianTextV1 } from '@echo-brain/provider-runtime/atlassian-document-text-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1, confluenceFailure } from './confluence-validation-v1.js';

/** Confluence REST v2 returns atlas_doc_format as a JSON-encoded ADF document. */
export function normalizeConfluencePageDocumentV1(value: string): Readonly<{ sections: readonly string[]; incomplete: boolean }> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) confluenceFailure('invalid_output');
  let document: unknown;
  try { document = JSON.parse(value); } catch { confluenceFailure('invalid_output'); }
  const normalized = normalizeAtlassianDocumentTextV1(document, CONFLUENCE_PERSON_PROVIDER_V1, {
    unsupported: 'omit', maximum_bytes: 512 * 1024, maximum_nodes: 50_000, maximum_depth: 64,
  });
  return Object.freeze({ sections: splitAtlassianTextV1(normalized.text), incomplete: normalized.incomplete });
}
