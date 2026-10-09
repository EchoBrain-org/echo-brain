import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1, personMeetingCommandV2, validatePersonMeetingRequestV2,
  validatePersonSyntheticMeetingV1, type PersonToolProviderV1 } from '@echo-brain/organization-api';

/** Bound reads, including a growing file; reject devices, directories and invalid UTF-8. */
function readMeeting(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1) throw new Error();
    const bytes = Buffer.alloc(PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1 + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1) throw new Error();
    return validatePersonSyntheticMeetingV1(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
  } catch { throw new Error('Meeting file must be a regular UTF-8 JSON file of at most 48 KiB with id (synthetic-custom-...), title, notes and transcript.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function createSyntheticMeetingToolV1(): PersonToolProviderV1 {
  return { tool_id: 'synthetic', verbs: { meetings: {
    description: 'Staging owner only: submit custom meeting JSON with --meeting-file and --retain; optionally suggest --echo-project. Or inspect/import/review using --request JSON. Submissions still require human approval.',
    options: { 'meeting-file': { type: 'string' }, retain: { type: 'boolean' }, 'echo-project': { type: 'string' }, request: { type: 'string' } },
    async run(context) {
      const { values } = context;
      if (values.request !== undefined && (values['meeting-file'] !== undefined || values.retain !== undefined || values['echo-project'] !== undefined)) {
        throw new Error('Choose a meeting file or a versioned request');
      }
      if (values.request === undefined && (typeof values['meeting-file'] !== 'string' || values.retain !== true)) {
        throw new Error('Custom submission requires --meeting-file and --retain');
      }
      const request = validatePersonMeetingRequestV2(values.request === undefined ? {
        schema_version: 2, tool_id: 'synthetic', operation: 'submit', retain: true,
        project_id: values['echo-project'] ?? null, meeting: readMeeting(String(values['meeting-file'])),
      } : JSON.parse(String(values.request)));
      if (values.request !== undefined && request.operation === 'submit') throw new Error('Custom submission requires --meeting-file and --retain; meeting content must not be passed in arguments');
      if (request.tool_id !== 'synthetic') throw new Error('Meeting request must select the synthetic staging tool');
      context.print({ ok: true, result: await personMeetingCommandV2(context.host, request) });
    },
  } } };
}
