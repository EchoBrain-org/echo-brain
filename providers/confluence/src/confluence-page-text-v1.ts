import { normalizeAtlassianDocumentTextV1, splitAtlassianTextV1 } from '@echo-brain/provider-runtime/atlassian-document-text-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1, confluenceFailure } from './confluence-validation-v1.js';

/** Confluence REST v2 returns atlas_doc_format as a JSON-encoded ADF document. */
export function normalizeConfluencePageDocumentV1(value: string): Readonly<{ sections: readonly string[]; incomplete: boolean }> {
  // The document is bounded by the provider response that carried it.
  if (typeof value !== 'string') confluenceFailure('invalid_output');
  let document: unknown;
  try { document = JSON.parse(value); } catch { confluenceFailure('invalid_output'); }
  const normalized = normalizeAtlassianDocumentTextV1(document, CONFLUENCE_PERSON_PROVIDER_V1, { unsupported: 'omit' });
  // A subtree too deeply nested to walk is left out, and the page says some content could not be represented.
  return Object.freeze({ sections: splitAtlassianTextV1(normalized.text), incomplete: normalized.incomplete || normalized.cut });
}
