import type { OrganizationReadableSearchRequestV1 } from '@echo-brain/organization-api';
import type {
  PreparedReadableSearchResponse,
  ReadableSearchRequestOptions,
} from '../application/readable-search.js';

/** The readable-search service hands HTTP its already-audited canonical bytes. */
export interface OrganizationReadableSearchHttpApplication {
  search(
    request: OrganizationReadableSearchRequestV1,
    options?: ReadableSearchRequestOptions,
  ): Promise<PreparedReadableSearchResponse>;
}
