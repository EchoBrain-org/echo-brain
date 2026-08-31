import type { ReadableSearchPlane } from '../application/readable-search-contracts.js';

export interface ReadableSearchPlaneDefinition {
  readonly plane: ReadableSearchPlane;
  readonly application_id: number;
}

export const READABLE_SEARCH_FACTS_DATABASE: ReadableSearchPlaneDefinition = {
  plane: 'facts',
  application_id: 0x45524654,
};

export const READABLE_SEARCH_LEXICAL_DATABASE: ReadableSearchPlaneDefinition = {
  plane: 'lexical',
  application_id: 0x45524c58,
};

export const READABLE_SEARCH_CONTENT_DATABASE: ReadableSearchPlaneDefinition = {
  plane: 'content',
  application_id: 0x45524354,
};
