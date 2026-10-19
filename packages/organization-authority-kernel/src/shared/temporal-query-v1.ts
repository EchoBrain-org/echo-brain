import { AuthorityOperationError } from '../domain/errors.js';

/** Authorized sources without event dates cannot establish absence in a date-filtered result. */
export const MISSING_EVENT_DATE_NOTICE_V1 = "Some accessible meetings are missing recorded event dates, so they could not be checked against the requested period. These results cannot establish that no meeting occurred.";

/**
 * Structured fields chosen by the model, never parsed from the person's question. `approved` is when an approved record
 * was approved; `sent`, `reassigned` and `checked` are a follow-up's own ECHO dates (research tool contract v1).
 */
export type EvidenceDateFieldV1 = 'occurred' | 'created' | 'updated' | 'due' | 'received' | 'approved' | 'sent' | 'reassigned' | 'checked';
/** Every date field, in the order a source's capabilities list them. */
export const EVIDENCE_DATE_FIELDS_V1: readonly EvidenceDateFieldV1[] = Object.freeze(['occurred', 'created', 'updated', 'due', 'received', 'approved', 'sent', 'reassigned', 'checked']);
/** The date fields every source accepted before the research tool contract; a source that takes more says so. */
const CLASSIC_DATE_FIELDS_V1: readonly EvidenceDateFieldV1[] = Object.freeze(['occurred', 'created', 'updated', 'due', 'received']);
/**
 * `any`: a window with no field matches an item when any of its dates falls in it (research tool contract v1). Only a
 * source whose capabilities declare `any_date` is sent it, and it validates it by naming it among its fields.
 */
export const EVIDENCE_ANY_DATE_V1 = 'any' as const;
export type EvidenceDateSelectionV1 = EvidenceDateFieldV1 | typeof EVIDENCE_ANY_DATE_V1;
export type EvidenceDatesV1 = Readonly<Partial<Record<EvidenceDateFieldV1, string>>>;
export function meetingEvidenceDatesV1(time: { readonly actual_start_at?: string; readonly scheduled_start_at?: string; readonly actual_end_at?: string; readonly scheduled_end_at?: string; readonly all_day?: boolean } | undefined): EvidenceDatesV1 {
  const stamp = time?.actual_start_at ?? time?.scheduled_start_at ?? time?.actual_end_at ?? time?.scheduled_end_at;
  return stamp === undefined ? {} : { occurred: time?.all_day ? stamp.slice(0, 10) : stamp };
}
export interface EvidenceDateFilterV1 {
  readonly since?: string;
  readonly until?: string;
  readonly date_field?: EvidenceDateSelectionV1;
  readonly time_zone?: string;
}
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function invalid(message: string): never { throw new AuthorityOperationError('invalid_request', message); }
export function calendarDateV1(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalid('Dates must be real YYYY-MM-DD calendar dates');
  return value;
}
export function validateEvidenceDateFilterV1(input: EvidenceDateFilterV1, fields?: readonly EvidenceDateSelectionV1[]): void {
  if (input.since !== undefined) calendarDateV1(input.since);
  if (input.until !== undefined) calendarDateV1(input.until);
  if (input.since !== undefined && input.until !== undefined && input.since > input.until) invalid('Date range is reversed');
  const accepted = fields ?? CLASSIC_DATE_FIELDS_V1;
  if (input.date_field !== undefined && !accepted.includes(input.date_field)) invalid(`This source supports date_field: ${accepted.join(', ')}`);
  if (input.time_zone !== undefined) {
    if (typeof input.time_zone !== "string" || input.time_zone.length > 100) invalid('Time zone is invalid');
    try { new Intl.DateTimeFormat('en', { timeZone: input.time_zone }); } catch { invalid('Time zone is invalid'); }
  }
}
/** Timestamps use the request's zone; calendar dates (deadlines/all-day events) keep their day. */
export function evidenceDayV1(value: string | undefined, timeZone = 'UTC'): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return calendarDateV1(value);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  let formatter = dayFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dayFormatters.size >= 32) dayFormatters.delete(dayFormatters.keys().next().value!);
    dayFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (kind: string) => parts.find(entry => entry.type === kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const timeFormatters = new Map<string, Intl.DateTimeFormat>();
/** The same instant with the client's local clock and explicit offset; date-only values are not instants. */
export function localEvidenceTimeV1(value: string | undefined, timeZone: string): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try { return calendarDateV1(value); } catch { return undefined; }
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  if (timeZone === 'UTC') return value.endsWith('Z') ? value : new Date(timestamp).toISOString();
  let formatter = timeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset' });
    if (timeFormatters.size >= 32) timeFormatters.delete(timeFormatters.keys().next().value!);
    timeFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (kind: string) => parts.find(entry => entry.type === kind)!.value;
  const offset = part('timeZoneName').replace(/^GMT/, '') || 'Z';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')}${offset}`;
}
/** A presentation copy only: authoritative source timestamps stay in the evidence desk and audit. */
export function localEvidenceDatesV1(dates: EvidenceDatesV1 | undefined, timeZone: string): EvidenceDatesV1 | undefined {
  if (dates === undefined) return undefined;
  const local = Object.fromEntries(Object.entries(dates).flatMap(([field, value]) => {
    const stamp = localEvidenceTimeV1(value, timeZone);
    return stamp === undefined ? [] : [[field, stamp]];
  })) as EvidenceDatesV1;
  return Object.keys(local).length === 0 ? undefined : Object.freeze(local);
}
export function matchesEvidenceDateV1(dates: EvidenceDatesV1, input: EvidenceDateFilterV1, defaultField: EvidenceDateFieldV1): boolean {
  if (input.since === undefined && input.until === undefined) return true;
  const within = (value: string | undefined) => {
    const day = evidenceDayV1(value, input.time_zone);
    return day !== undefined && (input.since === undefined || day >= input.since) && (input.until === undefined || day <= input.until);
  };
  if (input.date_field === EVIDENCE_ANY_DATE_V1) return Object.values(dates).some(within);
  return within(dates[input.date_field ?? defaultField]);
}
/** The date fields of `dates` that fall in the filter's window: what an `any` match shows the model it matched on. */
export function matchedEvidenceDatesV1(dates: EvidenceDatesV1 | undefined, input: EvidenceDateFilterV1): readonly EvidenceDateFieldV1[] {
  if (dates === undefined || (input.since === undefined && input.until === undefined)) return [];
  return EVIDENCE_DATE_FIELDS_V1.filter(field => dates[field] !== undefined && matchesEvidenceDateV1({ [field]: dates[field] }, { ...input, date_field: field }, field));
}
export function evidenceDateFilterV1(input: EvidenceDateFilterV1): EvidenceDateFilterV1 {
  return { ...(input.since === undefined ? {} : { since: input.since }), ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.date_field === undefined ? {} : { date_field: input.date_field }), ...(input.time_zone === undefined ? {} : { time_zone: input.time_zone }) };
}
