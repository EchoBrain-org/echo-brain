import { describe, expect, it } from 'vitest';
import {
  PERSON_HAND_IN_MEETING_MAX_BYTES_V1, personHandInMeetingV1, personHandInTextV1, validatePersonHandInMeetingV1, validatePersonMeetingRequestV2,
  validatePersonMeetingResultV2,
} from '../src/person-meetings-v1.js';

const project = 'prj_00000000-0000-4000-8000-000000000001';
const meeting = { title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.', transcript: '' };
const submit = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: null, meeting: { ...meeting, ...value }, ...extra });

describe('handed-in meetings', () => {
  it.each([
    ['no time', {}],
    ['a start', { started_at: '2026-10-21T22:30:00.000Z' }],
    ['a start, an end and a zone', { started_at: '2026-10-21T22:30:00.000Z', ended_at: '2026-10-21T23:00:00.000Z', time_zone: 'America/Los_Angeles' }],
    ['a whole day', { started_at: '2026-10-21T12:00:00.000Z', all_day: true }],
    ['a transcript alone', { notes: '', transcript: 'Mina Patel: I will send the revised quote.\n\nRafael Moreno: Friday works.' }],
    ['tabs and blank lines inside the text', { notes: 'Decisions\n\n\t- Move the pilot to Friday.' }],
  ])('accepts a retained hand-in with %s, suggested or not', (_name, value) => {
    expect(validatePersonMeetingRequestV2(submit(value))).toEqual(submit(value));
    expect(validatePersonMeetingRequestV2(submit(value, { project_id: project }))).toMatchObject({ project_id: project });
  });

  it.each([
    ['another meeting tool', {}, { tool_id: 'granola' }],
    ['no retention consent', {}, { retain: false }],
    ['a synthetic id', { id: 'synthetic-custom-supplier' }, {}],
    ['an unknown field', { provenance: {} }, {}],
    ['no notes and no transcript', { notes: '', transcript: '' }, {}],
    ['untrimmed notes', { notes: ' Decision: move the pilot.' }, {}],
    ['an untrimmed title', { title: 'Supplier sync ' }, {}],
    ['a carriage return', { notes: 'Decision:\r\nmove the pilot.' }, {}],
    ['text that is not NFC', { notes: 'Café decision.' }, {}],
    ['a control character', { notes: 'Decision\u0007 move the pilot.' }, {}],
    ['a C1 control character', { transcript: 'Speaker\u0085 Friday works.' }, {}],
    ['a lone surrogate', { notes: 'Decision \ud800 move the pilot.' }, {}],
    ['an empty title', { title: '' }, {}],
    ['a title over 200 characters', { title: 'T'.repeat(201) }, {}],
    ['a title of two lines', { title: 'Supplier\nsync' }, {}],
    ['a start that is not canonical', { started_at: '2026-10-21T22:30:00Z' }, {}],
    ['an end without a start', { ended_at: '2026-10-21T23:00:00.000Z' }, {}],
    ['an end before its start', { started_at: '2026-10-21T22:30:00.000Z', ended_at: '2026-10-21T22:00:00.000Z' }, {}],
    ['a zone without a start', { time_zone: 'Europe/Berlin' }, {}],
    ['an unknown zone', { started_at: '2026-10-21T22:30:00.000Z', time_zone: 'Mars/Olympus_Mons' }, {}],
    ['a whole day without its date', { all_day: true }, {}],
    ['a whole day that is not noon UTC', { started_at: '2026-10-21T07:00:00.000Z', all_day: true }, {}],
    ['a whole day at midnight UTC', { started_at: '2026-10-21T00:00:00.000Z', all_day: true }, {}],
    ['a whole day with a zone', { started_at: '2026-10-21T12:00:00.000Z', all_day: true, time_zone: 'Europe/Berlin' }, {}],
    ['a whole day with an end', { started_at: '2026-10-21T12:00:00.000Z', all_day: true, ended_at: '2026-10-22T12:00:00.000Z' }, {}],
    ['a whole day said as false', { started_at: '2026-10-21T12:00:00.000Z', all_day: false }, {}],
    ['a day that does not exist', { started_at: '2026-02-30T12:00:00.000Z', all_day: true }, {}],
    ['more than 60 KiB of text', { notes: '界'.repeat(20 * 1024 + 1) }, {}],
  ])('refuses %s', (_name, value, extra) => expect(() => validatePersonMeetingRequestV2(submit(value, extra))).toThrow());

  it('bounds the meeting by its JSON bytes at 60 KiB, inside the 64 KiB route body', () => {
    const exact = { ...meeting, notes: '' };
    exact.notes = 'n'.repeat(PERSON_HAND_IN_MEETING_MAX_BYTES_V1 - Buffer.byteLength(JSON.stringify(exact)));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(PERSON_HAND_IN_MEETING_MAX_BYTES_V1);
    expect(validatePersonHandInMeetingV1(exact)).toEqual(exact);
    expect(() => validatePersonHandInMeetingV1({ ...exact, notes: `${exact.notes}n` })).toThrow('bound');
    // A line feed counts as its two JSON bytes.
    expect(() => validatePersonHandInMeetingV1({ ...exact, notes: `${exact.notes.slice(0, 100)}\n${exact.notes.slice(101)}` })).toThrow('bound');
  });

  it('builds canonical text and either a start with its zone or a whole day', () => {
    expect(personHandInTextV1('﻿  Café notes\r\nline two\rline three \n\n')).toBe('Café notes\nline two\nline three');
    expect(personHandInMeetingV1({ title: ' Supplier sync ', notes: 'Decision: move the pilot.\r\n', transcript: ' ', date: '2026-10-21' }))
      .toEqual({ title: 'Supplier sync', notes: 'Decision: move the pilot.', transcript: '', started_at: '2026-10-21T12:00:00.000Z', all_day: true });
    expect(personHandInMeetingV1({ title: 'Supplier sync', notes: 'Decision.', transcript: '', started_at: '2026-10-21T22:30:00.000Z', time_zone: 'America/Los_Angeles' }))
      .toEqual({ title: 'Supplier sync', notes: 'Decision.', transcript: '', started_at: '2026-10-21T22:30:00.000Z', time_zone: 'America/Los_Angeles' });
    for (const input of [{ date: '2026-10-21', started_at: '2026-10-21T22:30:00.000Z' }, { date: '2026-10-21', time_zone: 'UTC' }, { date: '21/10/2026' }, { date: '2026-02-30' }]) {
      expect(() => personHandInMeetingV1({ title: 'Supplier sync', notes: 'Decision.', transcript: '', ...input })).toThrow();
    }
  });

  it('answers with the id derived from the content', () => {
    expect(validatePersonMeetingResultV2('submit', { status: 'queued', meeting_id: `hand-in-${'0f'.repeat(32)}` })).toEqual({ status: 'queued', meeting_id: `hand-in-${'0f'.repeat(32)}` });
    expect(validatePersonMeetingResultV2('submit', { status: 'queued', meeting_id: 'synthetic-custom-supplier' })).toMatchObject({ status: 'queued' });
    for (const meeting_id of [`hand-in-${'a'.repeat(63)}`, `hand-in-${'A'.repeat(64)}`, `hand-in-${'a'.repeat(65)}`, 'hand-in-supplier', `meeting-${'a'.repeat(64)}`]) {
      expect(() => validatePersonMeetingResultV2('submit', { status: 'queued', meeting_id })).toThrow();
    }
  });
});
