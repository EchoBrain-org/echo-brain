import { PERSON_HAND_IN_MEETING_MAX_BYTES_V1, PERSON_HAND_IN_TOOL_ID_V1, personHandInMeetingV1, personMeetingCommandV2, validatePersonMeetingRequestV2,
  type PersonToolProviderV1 } from '@echo-brain/organization-api';
import { readBoundedFile } from './update-file.js';

/** One bounded regular UTF-8 file, a growing one included; its text never enters arguments or output. */
function readText(path: string, option: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(path, PERSON_HAND_IN_MEETING_MAX_BYTES_V1)); }
  catch { throw new Error(`--${option} must be a readable regular UTF-8 text file of at most 60 KiB.`); }
}

/** A start as typed (ISO 8601, local time without an offset) as a UTC timestamp; anything else, a day that does not exist included, is refused. */
function startedAt(value: string): string {
  const day = value.slice(0, 10), parsed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('--started-at must be an ISO 8601 date and time, such as 2026-10-21T15:30');
  }
  return new Date(parsed).toISOString();
}

/**
 * Every member hands a meeting in from any tool: the text is read from files, and its import still needs the
 * person's approval. `meetings` reads and decides reviews with a versioned request that never carries meeting text.
 */
export function createHandInMeetingToolV1(): PersonToolProviderV1 {
  return { tool_id: PERSON_HAND_IN_TOOL_ID_V1, verbs: {
    submit: {
      description: 'Hand in a meeting from any tool: --meeting-title, --notes-file and/or --transcript-file (UTF-8, at most 60 KiB together), optionally --started-at <ISO time> or --date <YYYY-MM-DD> and --echo-project to suggest, and --retain. Its decisions and actions still need your approval.',
      options: { 'meeting-title': { type: 'string' }, 'notes-file': { type: 'string' }, 'transcript-file': { type: 'string' }, 'started-at': { type: 'string' },
        date: { type: 'string' }, 'echo-project': { type: 'string' }, retain: { type: 'boolean' } },
      requires: ['meeting-title', 'retain'],
      async run(context) {
        const { values } = context;
        if (values.retain !== true) throw new Error('Handing in a meeting requires --retain');
        if (values['notes-file'] === undefined && values['transcript-file'] === undefined) throw new Error('Hand in a meeting with --notes-file, --transcript-file or both');
        if (values['started-at'] !== undefined && values.date !== undefined) throw new Error('Choose --started-at or --date');
        // A start keeps this machine's time zone, so its day and relative dates read as the person meant them.
        const meeting = personHandInMeetingV1({
          title: String(values['meeting-title']),
          notes: values['notes-file'] === undefined ? '' : readText(String(values['notes-file']), 'notes-file'),
          transcript: values['transcript-file'] === undefined ? '' : readText(String(values['transcript-file']), 'transcript-file'),
          ...(values['started-at'] === undefined ? {} : { started_at: startedAt(String(values['started-at'])), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
          ...(values.date === undefined ? {} : { date: String(values.date) }),
        });
        const request = validatePersonMeetingRequestV2({ schema_version: 2, tool_id: PERSON_HAND_IN_TOOL_ID_V1, operation: 'submit', retain: true,
          project_id: values['echo-project'] ?? null, meeting });
        context.print({ ok: true, result: await personMeetingCommandV2(context.host, request) });
      },
    },
    meetings: {
      description: 'Read your meeting reviews, and approve or reject one, with a versioned JSON request. Hand meetings in with submit.',
      options: { request: { type: 'string' } }, requires: ['request'],
      async run(context) {
        const request = validatePersonMeetingRequestV2(JSON.parse(String(context.values.request)));
        if (request.tool_id !== PERSON_HAND_IN_TOOL_ID_V1) throw new Error('Meeting request must select the hand-in tool');
        if (request.operation === 'submit') throw new Error('Hand a meeting in with submit and its files; meeting text must not be passed in arguments');
        context.print({ ok: true, result: await personMeetingCommandV2(context.host, request) });
      },
    },
  } };
}
