import { describe, expect, it } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createPersonMeetingTranscriptReadRouteV1, createPersonSourceEvidenceRouteV1 } from '../src/composition/person-source-evidence-route.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const citation = {
  kind: 'source_revision' as const, source_id: `source:${'a'.repeat(64)}`, revision_id: 'r1',
  source_sha256: digest('b'), representation_sha256: digest('c'), anchor_sha256: digest('d'),
};

describe('opening cited originals and shared transcripts without an Ask model', () => {
  it('opens a cited original under the asker scope and returns the validated source evidence', () => {
    const seen: unknown[] = [];
    const app = createPersonSourceEvidenceRouteV1({
      originals: {
        read: (input: unknown) => {
          seen.push(input);
          return { scope: { kind: 'project', project_id: 'prj_00000000-0000-4000-8000-000000000001' }, atom: { ...citation, kind: 'source_revision', label: 'Atlas plan', text: 'The launch window is October.' } };
        },
      } as never,
    });
    const evidence = app.readSource({ access_token: 'token', request: { schema_version: 1, scope: { kind: 'project', project_id: 'prj_00000000-0000-4000-8000-000000000001' }, citation } as never });
    expect(seen).toEqual([{ access_token: 'token', scope: { kind: 'project', project_id: 'prj_00000000-0000-4000-8000-000000000001' }, citation }]);
    expect(evidence).toMatchObject({ kind: 'echo-person-source-evidence-v1', citation: { ...citation, label: 'Atlas plan' }, text: 'The launch window is October.' });
  });

  it('keeps transcript reads inside the original-context release gate', () => {
    const app = createPersonMeetingTranscriptReadRouteV1({
      originals: {
        readApprovedMeetingTranscript: () => {
          throw new AuthorityOperationError('unauthorized', 'transcript policy denied');
        },
      } as never,
    });
    expect(() => app.readTranscript({
      access_token: 'token',
      request: {
        schema_version: 1,
        scope: { kind: 'global' },
        citation: {
          kind: 'approved_meeting_transcript', approval_id: 'apr_fixture',
          source_id: `source:${'a'.repeat(64)}`, revision_id: 'r1', source_sha256: digest('b'),
        },
      },
    })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });
});
