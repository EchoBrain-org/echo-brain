import type { RetrievalLexicalDocument, RetrievalTermPosting } from '../application/contracts.js';
import { READABLE_SEARCH_LEXICAL_DATABASE } from './database-definition.js';
import { openAndMigrateReadableSearchPlane } from './open-plane.js';
import { ReadableSearchPlaneStore } from './plane-store.js';

export class ReadableSearchLexicalStore extends ReadableSearchPlaneStore {
  private constructor(path: string) {
    super(openAndMigrateReadableSearchPlane(path, READABLE_SEARCH_LEXICAL_DATABASE), 'lexical');
  }

  static open(path: string): ReadableSearchLexicalStore {
    return new ReadableSearchLexicalStore(path);
  }

  insertDocument(document: RetrievalLexicalDocument): void {
    this.database.prepare(
      `INSERT INTO retrieval_lexical_document
       (atom_id, log_position, atom_order, content_binding_sha256) VALUES (?, ?, ?, ?)`,
    ).run(document.atom_id, document.log_position, document.atom_order, document.content_binding_sha256);
  }

  insertPosting(posting: RetrievalTermPosting): void {
    this.database.prepare(
      'INSERT INTO retrieval_term_posting (term, atom_id, term_frequency) VALUES (?, ?, ?)',
    ).run(posting.term, posting.atom_id, posting.term_frequency);
  }

  documents(): readonly RetrievalLexicalDocument[] {
    return this.database.prepare(
      'SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id',
    ).all() as RetrievalLexicalDocument[];
  }

  postings(): readonly RetrievalTermPosting[] {
    return this.database.prepare(
      'SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id',
    ).all() as RetrievalTermPosting[];
  }
}
