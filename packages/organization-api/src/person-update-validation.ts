import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { PROJECT_CONTEXT_RESPONSE_MAX_BYTES } from './project-context-v1.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  asRecord,
  assertOnlyEnumerableDataProperties,
  fail,
} from './validation.js';

// Shared wire rules for V2/V3; version-specific shapes stay in their validators.
export function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}

export function text(value: unknown, label: string, maximum: number, multiline: boolean): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      Array.from(value).reduce((bytes, point) => { const n = point.codePointAt(0)!; return bytes + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4); }, 0) > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) ||
      (!multiline && /[\t\r\n]/u.test(value))) fail(`${label} is invalid`);
}

export function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Person update timestamp is invalid');
}

export function requestBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`);
}

export function responseBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) fail(`${label} exceeds JSON byte bound`);
}
