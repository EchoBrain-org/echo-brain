import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { PROJECT_CONTEXT_RESPONSE_MAX_BYTES } from './project-context-v1.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  fail,
} from './validation.js';

// Shared wire rules for the V2/V3 updates and the V2 project context; version-specific shapes stay in their validators.
export { asEnumerableRecord as object, assertBoundedText as text } from './validation.js';

export function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Person update timestamp is invalid');
}

export function requestBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`);
}

export function responseBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) fail(`${label} exceeds JSON byte bound`);
}
