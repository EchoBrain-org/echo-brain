export type ReadableSearchPlane = 'facts' | 'lexical' | 'content';

export class ReadableSearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadableSearchValidationError';
  }
}
