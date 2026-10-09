import type Database from 'better-sqlite3';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  PERSON_IMPACT_CARD_LIMITS_V1 as LIMITS,
  PERSON_SWEEP_RESULT_LIMITS_V1,
  validatePersonSweepResultV1,
  type PersonOpenItemKindV1,
  type PersonSweepFindingResultV1,
} from '@echo-brain/organization-api';
import type { createAgenticResearchV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1';
import { impactCardLineV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { SWEEP_RENDERER_V1, type SweepTriggerInputV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/sweep-renderer-v1';
import type { SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { TriggerRunRowV1, TriggerRunScopeV1 } from '../adapters/persistence/sqlite/trigger-runs-v1.js';
import { openItemDecisionAccessV1 } from './open-items-policy-v1.js';
import {
  assessOpenItemsV1, openItemDecisionPartsV1, openItemKindV1, sweepScopeOpenItemsV1,
  type AssessedOpenItemV1, type OpenItemsContextV1, type OpenItemSourcesV1, type OpenItemViewerV1,
} from './person-open-items-v1.js';
import type { PersonRecordAnchorV1, PersonRecordProjectsV1 } from './person-record-search-route.js';

/**
 * A sweep's own work (open items and Home v1, section 6; ADR-0033): which
 * open items it rechecks, what it tells research about each, and the verdicts
 * it keeps. It acts as the person who asked, with their access. At start it
 * takes up to 20 of the items they see in its scope, the never-checked first,
 * then those checked longest ago. Each becomes a finding with the item first
 * and, for a decision reader only, the decision after it (R33). The run stores
 * the counts by verdict; each item keeps only its verdict as the shared last
 * check, replaced only by a newer one, and only on an item the caller still
 * sees as the run finishes. A sweep never changes an item's state.
 */

/** What a finished sweep stores: how many of its findings had each verdict, nothing else. */
export interface SweepCountsV1 {
  readonly schema_version: 1;
  readonly landed: number; readonly still_open: number; readonly changed: number; readonly unreadable: number; readonly not_assessed: number;
}
/** Where a sweep reads its items and their decisions, and writes its checks. */
export interface PersonSweepSourcesV1 extends OpenItemSourcesV1 {
  readonly items: OpenItemSourcesV1['items'] & Pick<SqliteImpactItemsV1, 'read' | 'recordCheck'>;
  readonly records: OpenItemSourcesV1['records'] & PersonRecordAnchorV1 & PersonRecordProjectsV1;
}
/** Where research reads: a project, or everything the person may read. */
type DeskScope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };
type Research = Pick<ReturnType<typeof createAgenticResearchV1>, 'renderWithResearch'>;

const SWEEP = AGENTIC_TRIGGER_DEFINITIONS_V1.find(definition => definition.name === 'sweep')!;
const GLOBAL = Object.freeze({ kind: 'global' as const });
/** How a finding names its item: what the impact check found it to be, and what it is. */
const RELATION_WORDS = Object.freeze({ conflicts: 'Conflicting', needs_updating: 'Outdated', not_assessed: 'Affected' });
const KIND_WORDS: Readonly<Record<PersonOpenItemKindV1, string>> = Object.freeze({
  ticket: 'Jira ticket', page: 'page', slack_message: 'Slack message', record: 'ECHO record', document: 'ECHO document',
});
/** What a finding expects of an item with no phrase of its own, for a caller not shown the decision's first line. */
const APPROVED_DECISION = 'the approved decision';

function ascending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
/** Never checked first, then the check longest ago; then the oldest item. */
function longestUncheckedFirst(left: AssessedOpenItemV1, right: AssessedOpenItemV1): number {
  return ascending(left.row.check?.at ?? '', right.row.check?.at ?? '') || ascending(left.row.created_at, right.row.created_at) || ascending(left.row.item_id, right.row.item_id);
}
function countsOf(findings: readonly Pick<PersonSweepFindingResultV1, 'verdict'>[]): SweepCountsV1 {
  const count = (verdict: PersonSweepFindingResultV1['verdict']) => findings.filter(entry => entry.verdict === verdict).length;
  return Object.freeze({ schema_version: 1 as const, landed: count('landed'), still_open: count('still_open'), changed: count('changed'), unreadable: count('unreadable'), not_assessed: count(null) });
}

/**
 * A project sweep reads in its project; a decision's, in the decision's
 * project when the caller is shown the decision; any other, everywhere the
 * caller may read.
 */
function deskScopeOf(sources: PersonSweepSourcesV1, viewer: OpenItemViewerV1, scope: TriggerRunScopeV1, context: OpenItemsContextV1): DeskScope {
  if (scope.kind === 'project') return Object.freeze({ kind: 'project', project_id: scope.project_id });
  if (scope.kind === 'record' && openItemDecisionAccessV1({ reads_decision: context.decisions.has(scope.record_sha256) }).see_decision) {
    const projects = sources.records.recordProjects({ access_token: viewer.token, record_sha256: scope.record_sha256 });
    return projects.length === 1 ? Object.freeze({ kind: 'project', project_id: projects[0]! }) : GLOBAL;
  }
  return GLOBAL;
}

/** The items the caller still sees as the sweep finishes, each read again and asked of the policy again. */
function stillSeen(sources: PersonSweepSourcesV1, viewer: OpenItemViewerV1, checked: readonly AssessedOpenItemV1[]): ReadonlySet<string> {
  const rows = checked.flatMap(({ row }) => { const current = sources.items.read(row.item_id); return current === undefined ? [] : [current]; });
  return new Set(assessOpenItemsV1(sources, viewer, rows).assessed.filter(entry => entry.access.see_row).map(entry => entry.row.item_id));
}

/**
 * One attempt of a sweep run: research the items it rechecks, as the caller,
 * and answer what the run stores and, through `writes`, the checks its
 * finishing transaction writes. With no item left to check, it reads nothing
 * and binds no desk: `fenceSession` lets a diagnostic capture check the
 * session alone.
 */
export async function sweepOpenItemsV1(input: {
  readonly sources: PersonSweepSourcesV1;
  readonly viewer: OpenItemViewerV1;
  readonly run: TriggerRunRowV1;
  /** Research on a desk bound to the caller in `scope`. */
  readonly research: (scope: DeskScope) => Promise<Research>;
  /** Makes the caller's session the run's access fence, for an attempt that binds no desk. */
  readonly fenceSession: () => void;
  readonly signal: AbortSignal;
  /** When this attempt read the items: the time its checks carry, so a check made meanwhile stays newer. */
  readonly checked_at: string;
}): Promise<{ readonly result: SweepCountsV1; readonly writes?: () => (transaction: Database.Database) => void }> {
  const { sources, viewer, run } = input;
  if (run.scope === null) throw new Error('A sweep run has a scope');
  const context = sweepScopeOpenItemsV1(sources, viewer, run.scope);
  const checked = [...context.assessed].sort(longestUncheckedFirst).slice(0, PERSON_SWEEP_RESULT_LIMITS_V1.findings);
  // Every item closed, or went out of the caller's sight, since the sweep was asked for.
  if (checked.length === 0) {
    input.fenceSession();
    return { result: countsOf([]) };
  }

  const decisionPart = openItemDecisionPartsV1(sources, context);
  const anchors = new Map<Sha256Digest, unknown>();
  const anchorOf = (record: Sha256Digest) => {
    if (!anchors.has(record)) anchors.set(record, sources.records.recordAnchor({ access_token: viewer.token, record_sha256: record }));
    return anchors.get(record);
  };
  const findings = checked.map(entry => {
    const { row } = entry;
    const decision = decisionPart(entry);
    const item = `${RELATION_WORDS[row.relation ?? 'not_assessed']} ${KIND_WORDS[openItemKindV1(row.pointer)]}`;
    // A short phrase, as an item's own `expected` is.
    const firstLine = decision?.first_line == null ? '' : impactCardLineV1(decision.first_line, LIMITS.expected_chars);
    return {
      finding: decision === undefined ? item : `${item} from ${decision.title}`,
      expected: row.expected ?? (firstLine || APPROVED_DECISION),
      // The item first: the renderer judges a finding against its own items. The decision after it is context.
      citations: decision === undefined ? [row.pointer] : [row.pointer, anchorOf(row.record_sha256)],
    };
  });

  const research = await input.research(deskScopeOf(sources, viewer, run.scope, context));
  const event = SWEEP.parseEvent({ findings }) as SweepTriggerInputV1;
  const output = await research.renderWithResearch({ trigger: SWEEP.name, brief: SWEEP.brief(event), renderer: SWEEP_RENDERER_V1, trigger_input: event, signal: input.signal });
  const result = validatePersonSweepResultV1(output.rendered, findings.length);

  return {
    result: countsOf(result.findings),
    // Who sees what is asked again as the run finishes, in the same synchronous step as its transaction. It cannot run inside
    // it: the record check behind it reads the person's project grants in a transaction of its own, which never nests.
    writes: () => {
      const seen = stillSeen(sources, viewer, checked);
      return transaction => {
        for (const finding of result.findings) {
          const { row } = checked[finding.finding_index]!;
          // Not assessed leaves the last check as it is; an item the caller no longer sees keeps it too.
          if (finding.verdict === null || !seen.has(row.item_id)) continue;
          sources.items.recordCheck(transaction, { item_id: row.item_id, verdict: finding.verdict, by: viewer.membership, at: input.checked_at, run_id: run.run_id });
        }
      };
    },
  };
}
