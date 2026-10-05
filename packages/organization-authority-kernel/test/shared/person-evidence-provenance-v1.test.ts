import { describe, expect, it } from 'vitest';
import { isRetainedPersonEvidenceCitationV1 } from '../../src/shared/person-evidence-provenance-v1.js';

describe('Person evidence content provenance', () => {
  it('permits retained context and defaults all other citation kinds to request-only', () => {
    for (const kind of ['approved_record', 'source_revision']) {
      expect(isRetainedPersonEvidenceCitationV1({ kind })).toBe(true);
    }
    for (const kind of ['slack_message', 'ticket', 'page', 'future_external_context']) {
      expect(isRetainedPersonEvidenceCitationV1({ kind })).toBe(false);
    }
  });
});
