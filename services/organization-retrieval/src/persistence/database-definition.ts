import type { ReadableSearchPlane } from '../application/contracts.js';

export interface ReadableSearchPlaneDefinition {
  readonly plane: ReadableSearchPlane;
  readonly application_id: number;
  readonly migrations_directory: URL;
}

export const READABLE_SEARCH_FACTS_DATABASE: ReadableSearchPlaneDefinition = {
  plane: 'facts',
  application_id: 0x45524654,
  migrations_directory: new URL('../../migrations/facts/', import.meta.url),
};

export const READABLE_SEARCH_LEXICAL_DATABASE: ReadableSearchPlaneDefinition = {
  plane: 'lexical',
  application_id: 0x45524c58,
  migrations_directory: new URL('../../migrations/lexical/', import.meta.url),
};

export const READABLE_SEARCH_CONTENT_DATABASE: ReadableSearchPlaneDefinition = {
  plane: 'content',
  application_id: 0x45524354,
  migrations_directory: new URL('../../migrations/content/', import.meta.url),
};
