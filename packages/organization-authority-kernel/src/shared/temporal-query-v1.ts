import { AuthorityOperationError } from '../domain/errors.js';

/** Structured fields chosen by the model, never parsed from the person's question. */
export type EvidenceDateFieldV1 = 'occurred' | 'created' | 'updated' | 'due' | 'received';
export type EvidenceDatesV1 = Readonly<Partial<Record<EvidenceDateFieldV1, string>>>;
export function meetingEvidenceDatesV1(time: { readonly actual_start_at?: string; readonly scheduled_start_at?: string; readonly actual_end_at?: string; readonly scheduled_end_at?: string; readonly all_day?: boolean } | undefined): EvidenceDatesV1 {
  const stamp = time?.actual_start_at ?? time?.scheduled_start_at ?? time?.actual_end_at ?? time?.scheduled_end_at;
  return stamp === undefined ? {} : { occurred: time?.all_day ? stamp.slice(0, 10) : stamp };
}
export interface EvidenceDateFilterV1 {
  readonly since?: string;
  readonly until?: string;
  readonly date_field?: EvidenceDateFieldV1;
  readonly time_zone?: string;
}
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function invalid(message: string): never { throw new AuthorityOperationError('invalid_request', message); }
export function calendarDateV1(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalid('Dates must be real YYYY-MM-DD calendar dates');
  return value;
}
export function validateEvidenceDateFilterV1(input: EvidenceDateFilterV1, fields?: readonly EvidenceDateFieldV1[]): void {
  if (input.since !== undefined) calendarDateV1(input.since);
  if (input.until !== undefined) calendarDateV1(input.until);
  if (input.since !== undefined && input.until !== undefined && input.since > input.until) invalid('Date range is reversed');
  if (input.date_field !== undefined && !(fields ?? ['occurred', 'created', 'updated', 'due', 'received']).includes(input.date_field)) invalid(`This source supports date_field: ${fields?.join(', ') ?? 'occurred, created, updated, due, received'}`);
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
export function matchesEvidenceDateV1(dates: EvidenceDatesV1, input: EvidenceDateFilterV1, defaultField: EvidenceDateFieldV1): boolean {
  if (input.since === undefined && input.until === undefined) return true;
  const day = evidenceDayV1(dates[input.date_field ?? defaultField], input.time_zone);
  return day !== undefined && (input.since === undefined || day >= input.since) && (input.until === undefined || day <= input.until);
}
export function evidenceDateFilterV1(input: EvidenceDateFilterV1): EvidenceDateFilterV1 {
  return { ...(input.since === undefined ? {} : { since: input.since }), ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.date_field === undefined ? {} : { date_field: input.date_field }), ...(input.time_zone === undefined ? {} : { time_zone: input.time_zone }) };
}
