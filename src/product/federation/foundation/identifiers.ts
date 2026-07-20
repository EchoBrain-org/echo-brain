import { randomUUID } from 'node:crypto';

export type FederationIdPrefix =
  | 'org'
  | 'prn'
  | 'mem'
  | 'dev'
  | 'ins'
  | 'idm'
  | 'clm'
  | 'con'
  | 'bnd'
  | 'reg'
  | 'pol'
  | 'obs'
  | 'evt'
  | 'rec'
  | 'exp'
  | 'oau'
  | 'ech'
  | 'enr'
  | 'igr';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function federationId(prefix: FederationIdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function assertFederationId(
  value: string,
  prefix: FederationIdPrefix,
  label: string,
): void {
  if (!value.startsWith(`${prefix}_`) || !UUID_PATTERN.test(value.slice(prefix.length + 1))) {
    throw new Error(`${label} must be a canonical ${prefix} identifier`);
  }
}

export function assertUtcMillisecondTimestamp(value: string, label: string): void {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(
      value,
    );
  if (match === null) {
    throw new Error(`${label} must be a UTC millisecond timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`${label} is not a real UTC timestamp`);
  }
}
