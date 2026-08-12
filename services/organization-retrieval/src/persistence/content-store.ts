import type { RetrievalContentAtom } from '../application/contracts.js';
import { READABLE_SEARCH_CONTENT_DATABASE } from './database-definition.js';
import { openReadableSearchPlane } from './open-plane.js';
import { ReadableSearchPlaneStore } from './plane-store.js';

export class ReadableSearchContentStore extends ReadableSearchPlaneStore {
  private constructor(path: string) {
    super(openReadableSearchPlane(path, READABLE_SEARCH_CONTENT_DATABASE), 'content');
  }

  static open(path: string): ReadableSearchContentStore {
    return new ReadableSearchContentStore(path);
  }

  insert(atom: RetrievalContentAtom): void {
    this.database.prepare(
      `INSERT INTO retrieval_content_atom (
        atom_id, log_position, record_hash, atom_order, item_kind, text,
        text_sha256, content_binding_sha256, provenance_binding_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      atom.atom_id, atom.log_position, atom.record_hash, atom.atom_order, atom.item_kind,
      atom.text, atom.text_sha256, atom.content_binding_sha256, atom.provenance_binding_sha256,
    );
  }

  rows(): readonly RetrievalContentAtom[] {
    return this.database.prepare(
      'SELECT * FROM retrieval_content_atom ORDER BY log_position, atom_order, atom_id',
    ).all() as RetrievalContentAtom[];
  }
}
