import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonWorkspaceCitationV1 } from '@echo-brain/organization-api';
import type Database from 'better-sqlite3';
import type { AgenticAskAuditRequestContextV1 } from '../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import type { PersonWorkspaceReleaseAuditV1 } from './person-workspace-evidence-v1.js';

const SOURCES: ReadonlySet<string> = new Set(['projects', 'people', 'tools']);
const OPERATIONS: ReadonlySet<string> = new Set(['search', 'list', 'open']);
/** Each item kind's id, as its workspace citation names it. */
const ID_FIELDS: Readonly<Record<string, string>> = Object.freeze({ project: 'project_id', person: 'membership_id', tool: 'tool_id' });
const DIGEST = /^sha256:[a-f0-9]{64}$/;
/** A page of rows and the items released beside them. */
const RELEASE_ITEMS_MAX = 200;

/** An item named only by the id its citation would carry, and a digest of what was released. */
function validItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, item_id, linked, released_fields_sha256 } = value as Record<string, unknown>;
  const field = typeof kind === 'string' && Object.hasOwn(ID_FIELDS, kind) ? ID_FIELDS[kind] : undefined;
  if (field === undefined || typeof item_id !== 'string' || typeof linked !== 'boolean' || typeof released_fields_sha256 !== 'string' || !DIGEST.test(released_fields_sha256)) return false;
  try { validatePersonWorkspaceCitationV1({ kind, [field]: item_id }); return true; } catch { return false; }
}

/** Validates the trusted request context and copies exactly its fields. */
function bind(context: AgenticAskAuditRequestContextV1): AgenticAskAuditRequestContextV1 {
  if (![context.authority_id, context.organization_id, context.state_lineage_id, context.principal_id, context.membership_id, context.session_family_id, context.request_id]
    .every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) throw new Error('Workspace release audit context is invalid');
  return Object.freeze({
    authority_id: context.authority_id, organization_id: context.organization_id, state_lineage_id: context.state_lineage_id, principal_id: context.principal_id,
    membership_id: context.membership_id, session_family_id: context.session_family_id, request_id: context.request_id,
  });
}

/**
 * A content-free witness of each workspace release (research tool contract v1), in the same table and request context as
 * the Ask's other release witnesses, as follow-ups witness theirs (ADR-0040): the source, the operation, and each item's
 * kind, id, whether it was released beside the result, and a digest of its released fields. Empty releases are committed
 * too.
 */
export function createPersonWorkspaceReleaseAuditV1(database: Database.Database, context: AgenticAskAuditRequestContextV1,
  now: () => string = () => new Date().toISOString()): PersonWorkspaceReleaseAuditV1 {
  const bound = bind(context);
  let releaseSequence = 0;
  return Object.freeze<PersonWorkspaceReleaseAuditV1>({ record: (release) => {
    if (!SOURCES.has(release.source) || !OPERATIONS.has(release.operation) || !Array.isArray(release.items) || release.items.length > RELEASE_ITEMS_MAX ||
        !release.items.every(validItem) || new Set(release.items.map(item => `${item.kind}:${item.item_id}`)).size !== release.items.length) {
      throw new Error('Workspace release audit is invalid');
    }
    // Copy an explicit allowlist: the release carries nothing else, and nothing else is kept.
    const items = release.items.map(item => ({ kind: item.kind, item_id: item.item_id, linked: item.linked, released_fields_sha256: item.released_fields_sha256 }));
    const recorded_at = now();
    const prompt_sha256 = canonicalSha256({ kind: 'echo-person-workspace-selection-v1', source: release.source, operation: release.operation });
    const answer_sha256 = canonicalSha256(items);
    const body = { schema_version: 1, kind: 'echo-person-workspace-release-audit-v1', context_kind: 'answer_composition', ...bound,
      release_sequence: ++releaseSequence, source: release.source, operation: release.operation, items, prompt_sha256, answer_sha256, recorded_at };
    const receipt = canonicalSha256(body);
    database.prepare(`INSERT INTO authority_person_read_decision_audit_v2
      (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
      VALUES (?, ?, 'answer_composition', ?, ?, ?)`).run(receipt, canonicalJson(body), prompt_sha256, answer_sha256, recorded_at);
    return receipt;
  } });
}
