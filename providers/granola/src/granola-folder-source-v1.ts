import { canonicalJson } from '@echo-brain/federation-protocol';
import type { AdapterConfig, AdapterOperationContext, MeetingDocument, MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import type { GranolaPersonConnectionV1 } from './granola-person-connection-v1.js';
import { GRANOLA_ID_V1, GRANOLA_PERSON_PROVIDER_V1, granolaMcpMeetingContentV1 } from './granola-mcp-v1.js';
import { normalizeGranolaMeetingV1 } from './granola-meeting-normalizer-v1.js';

export interface GranolaCheckpointV1 { readonly folder: string | null; readonly baseline: boolean; readonly revisions: Readonly<Record<string, string>>; readonly manual: readonly string[] }
const prefix = 'granola-folder-v1:';
export function readGranolaCheckpointV1(cursor: string): GranolaCheckpointV1 {
  const fail: () => never = () => GRANOLA_PERSON_PROVIDER_V1.failure('invalid_request');
  if (!cursor.startsWith(prefix) || Buffer.byteLength(cursor) > 16_384) fail();
  let value: unknown;
  try { value = JSON.parse(cursor.slice(prefix.length)); } catch { fail(); }
  const row = GRANOLA_PERSON_PROVIDER_V1.record(value);
  if (Object.keys(row).sort().join(',') !== 'baseline,folder,manual,revisions' || (row.folder !== null && (typeof row.folder !== 'string' || !GRANOLA_ID_V1.test(row.folder))) || typeof row.baseline !== 'boolean') fail();
  const manual = GRANOLA_PERSON_PROVIDER_V1.array(row.manual, 50);
  if (manual.some(id => typeof id !== 'string' || !GRANOLA_ID_V1.test(id)) || new Set(manual).size !== manual.length) fail();
  const revisions = GRANOLA_PERSON_PROVIDER_V1.record(row.revisions);
  if (Object.keys(revisions).length > 50 || Object.entries(revisions).some(([key, revision]) => !GRANOLA_ID_V1.test(key) || typeof revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(revision)) || (!row.baseline && Object.keys(revisions).length !== 0)) fail();
  return row as unknown as GranolaCheckpointV1;
}
export function writeGranolaCheckpointV1(checkpoint: GranolaCheckpointV1): string { const cursor = prefix + canonicalJson(checkpoint); readGranolaCheckpointV1(cursor); return cursor; }
export function granolaFolderInitialCursorV1(folder: string | null): string { return writeGranolaCheckpointV1({ folder, baseline: false, revisions: {}, manual: [] }); }
export const GRANOLA_FOLDER_CURSOR_POLICY_V1: AdmittedMeetingSourceCursorPolicyV1 = Object.freeze({
  source_adapter_id: 'granola-person-mcp', assert_live_cursor(cursor: string) { readGranolaCheckpointV1(cursor); },
});
type FullSession = Awaited<ReturnType<GranolaPersonConnectionV1['open']>>;
export interface GranolaFolderReadSessionV1 {
  readonly identity: MeetingSourceAdapter['identity'];
  readonly api: Pick<FullSession['api'], 'details' | 'meeting' | 'transcript'>;
  current(): void;
  verify(): Promise<unknown>;
  folder(id: string): Promise<{ readonly meetings: Awaited<ReturnType<FullSession['folder']>>['meetings'] }>;
}


/** One meeting per shared processing cycle. The durable checkpoint contains no meeting text. */
export class GranolaFolderSourceV1 implements MeetingSourceAdapter {
  private fence: (() => void) | undefined;
  constructor(readonly identity: MeetingSourceAdapter['identity'], private readonly folderId: string | null,
    private readonly open: (signal?: AbortSignal) => Promise<GranolaFolderReadSessionV1>, private readonly requireMapping: () => void) {
    granolaFolderInitialCursorV1(folderId);
  }
  validateConfig(config: AdapterConfig) {
    return { ok: config.adapter_id === this.identity.adapter_id && config.instance_id === this.identity.instance_id,
      errors: config.adapter_id === this.identity.adapter_id && config.instance_id === this.identity.instance_id ? [] : ['Granola source identity differs'] };
  }
  async healthCheck(context?: AdapterOperationContext) {
    const checked_at = new Date().toISOString();
    try { this.requireMapping(); await this.open(context?.signal); return { status: 'healthy' as const, checked_at }; }
    catch { return { status: 'unavailable' as const, checked_at, message: 'Granola connection needs attention' }; }
  }
  /** Called again by Authority inside the existing source-custody transaction. */
  requireCurrent(): void {
    this.requireMapping();
    if (this.fence === undefined) throw new Error('Granola observation has not been authorized');
    this.fence();
  }
  async pull(request: Parameters<MeetingSourceAdapter['pull']>[0], operation?: AdapterOperationContext) {
    this.requireMapping();
    const checkpoint = readGranolaCheckpointV1(request.cursor ?? granolaFolderInitialCursorV1(this.folderId));
    if (checkpoint.folder !== this.folderId) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    const session = await this.open(operation?.signal);
    if (session.identity.adapter_id !== this.identity.adapter_id || session.identity.version !== this.identity.version ||
        (session.identity.instance_id !== this.identity.instance_id && !this.identity.instance_id.startsWith(session.identity.instance_id + '-'))) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    this.fence = session.current;
    const manual = checkpoint.manual[0];
    if (manual !== undefined) {
      const detail = await session.api.meeting(manual, operation?.signal);
      const transcript = await session.api.transcript(manual, operation?.signal);
      await session.verify(); this.requireCurrent();
      return { meetings: [normalizeGranolaMeetingV1(granolaMcpMeetingContentV1(detail, transcript), this.identity, new Date().toISOString())],
        next_cursor: writeGranolaCheckpointV1({ ...checkpoint, manual: checkpoint.manual.slice(1) }) };
    }
    if (this.folderId === null) return { meetings: [] };
    const before = await session.folder(this.folderId);
    const present = new Set(before.meetings.map(meeting => meeting.id));
    const revisions: Record<string, string> = Object.fromEntries(Object.entries(checkpoint.revisions).filter(([id]) => present.has(id)));
    let selected: MeetingDocument | undefined;
    // Granola exposes neither update times nor pagination. Bounded content comparison is required.
    for (let offset = 0; offset < before.meetings.length; offset += 10) {
      this.requireCurrent(); operation?.signal.throwIfAborted();
      const details = await session.api.details(before.meetings.slice(offset, offset + 10).map(meeting => meeting.id), operation?.signal);
      for (const detail of details) {
        this.requireCurrent();
        const transcript = await session.api.transcript(detail.id, operation?.signal);
        const meeting = normalizeGranolaMeetingV1(granolaMcpMeetingContentV1(detail, transcript), this.identity, new Date().toISOString());
        const revision = meeting.provenance.canonical_revision;
        if (checkpoint.baseline && revisions[detail.id] !== revision) { selected = meeting; revisions[detail.id] = revision; break; }
        revisions[detail.id] = revision;
      }
      if (selected !== undefined) break;
    }
    // A removed folder/item or changed account cannot be admitted from the earlier observation.
    const after = await session.folder(this.folderId);
    if (canonicalJson([...present].sort()) !== canonicalJson(after.meetings.map(meeting => meeting.id).sort())) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    this.requireCurrent();
    return { meetings: selected === undefined ? [] : [selected], next_cursor: writeGranolaCheckpointV1({ folder: this.folderId, baseline: true, revisions, manual: [] }) };
  }
}
