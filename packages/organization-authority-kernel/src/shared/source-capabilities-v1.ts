import type { EvidenceSourceCapabilitiesV1 } from './evidence-desk-v2.js';

/**
 * The capabilities of ECHO's two built-in Ask sources (research tool contract
 * v1). Follow-ups, the workspace sources and each connector declare their own
 * beside their descriptors.
 */

/** Imported meeting notes, approved decisions, actions and rationale, and shared transcripts. */
export const MEETINGS_SOURCE_CAPABILITIES_V1: EvidenceSourceCapabilitiesV1 = Object.freeze({
  filters: Object.freeze({ kind: Object.freeze(['decision', 'action', 'rationale']), status: Object.freeze(['open', 'done']), owner: 'name' as const }),
  dates: Object.freeze({
    occurred: 'when the meeting happened; only meetings with a recorded time have it',
    approved: 'when an approved decision, action or rationale was approved; every approved record has it',
    received: 'when ECHO received imported notes or a transcript; approved records do not have it',
    due: 'when a meeting action is due; only actions with a due date have it',
  }),
  any_date: true,
  links: Object.freeze([]),
});

/** Uploaded document passages and notes. */
export const DOCUMENTS_SOURCE_CAPABILITIES_V1: EvidenceSourceCapabilitiesV1 = Object.freeze({
  filters: Object.freeze({}),
  dates: Object.freeze({ received: 'when ECHO received the document; every document has it' }),
  any_date: true,
  links: Object.freeze([]),
});
