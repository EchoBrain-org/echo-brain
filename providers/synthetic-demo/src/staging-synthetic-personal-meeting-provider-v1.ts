import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import type { ProviderHttpApplicationV1 } from "@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import {
  AdapterError,
  assertCanonicalMeetingDocument,
  type AdapterConfig,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from "@echo-brain/organization-processing/core";
import type { AdmittedMeetingSourceCursorPolicyV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1";

export const STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1 = "staging-synthetic-meeting";
export const STAGING_SYNTHETIC_TOOL_ID_V1 = "synthetic";
export const STAGING_SYNTHETIC_CANARY_MEETING_ID_V1 = "synthetic-release-canary";
/** The admission label that keeps synthetic custody distinct from a person's OAuth account. */
export const STAGING_SYNTHETIC_CUSTODIAN_ASSURANCE_V1 = "staging_synthetic";
const VERSION = "1.0.0";
const NORMALIZER_VERSION = "staging-synthetic-meeting-v1";
const CURSOR_PREFIX = "staging-synthetic-meeting-v1:";
const MEETING_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
/** The meetings API bounds pending imports at 50; fixtures leave room for the canary. */
const MAXIMUM_PENDING = 50;
const MAXIMUM_FIXTURES = 40;
const MAXIMUM_FIXTURE_BYTES = 256 * 1024;

/** The personal checkpoint shape; this source has no folders and no baseline. */
export interface StagingSyntheticCheckpointV1 {
  readonly folder: string | null;
  readonly baseline: boolean;
  readonly revisions: Readonly<Record<string, string>>;
  readonly manual: readonly string[];
}

function invalidCursor(): never {
  throw new AdapterError("invalid_config", "staging synthetic meeting cursor is invalid", false);
}

export function readStagingSyntheticCheckpointV1(cursor: string): StagingSyntheticCheckpointV1 {
  if (!cursor.startsWith(CURSOR_PREFIX) || Buffer.byteLength(cursor) > 16_384) invalidCursor();
  let value: unknown;
  try { value = JSON.parse(cursor.slice(CURSOR_PREFIX.length)); } catch { invalidCursor(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidCursor();
  const row = value as Record<string, unknown>;
  const { manual, revisions } = row;
  if (Object.keys(row).sort().join(",") !== "baseline,folder,manual,revisions" || row.folder !== null || row.baseline !== false ||
      revisions === null || typeof revisions !== "object" || Array.isArray(revisions) || Object.keys(revisions).length !== 0 ||
      !Array.isArray(manual) || manual.length > MAXIMUM_PENDING ||
      manual.some(id => typeof id !== "string" || !MEETING_ID.test(id)) || new Set(manual).size !== manual.length) invalidCursor();
  return row as unknown as StagingSyntheticCheckpointV1;
}

export function writeStagingSyntheticCheckpointV1(checkpoint: StagingSyntheticCheckpointV1): string {
  const cursor = CURSOR_PREFIX + canonicalJson(checkpoint as never);
  readStagingSyntheticCheckpointV1(cursor);
  return cursor;
}

const CURSOR_POLICY: AdmittedMeetingSourceCursorPolicyV1 = Object.freeze({
  source_adapter_id: STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1,
  assert_live_cursor(cursor: string) { readStagingSyntheticCheckpointV1(cursor); },
});

/** The fixed release canary. Its revision follows its body, so a changed body is a new proposal. */
function canaryMeeting(): MeetingDocument {
  const body = {
    title: "SYNTHETIC STAGING CANARY - Release approval check",
    lifecycle: "completed" as const,
    capture: { state: "complete" as const, components: [
      { kind: "metadata" as const, state: "available" as const },
      { kind: "notes" as const, state: "available" as const },
      { kind: "transcript" as const, state: "available" as const },
    ] },
    participants: [{ id: "staging-owner", display_name: "Staging canary owner", roles: ["organizer" as const] }],
    content: [
      { id: "synthetic-decision", kind: "note" as const, origin: "unknown" as const,
        text: "Synthetic staging canary only. Decision: this release must verify owner approval of a staged meeting." },
      { id: "synthetic-action", kind: "note" as const, origin: "unknown" as const,
        text: "Synthetic staging canary only. Action: approve this proposal and choose who can read it." },
      { id: "synthetic-rationale", kind: "note" as const, origin: "unknown" as const,
        text: "Synthetic staging canary only. Rationale: exercise the release without creating a real meeting." },
      { id: "synthetic-transcript", kind: "transcript" as const, origin: "unknown" as const, speaker_participant_id: "staging-owner",
        text: "Synthetic staging canary transcript. The staging owner confirms this release requires owner approval. This is synthetic and not a real meeting." },
    ],
    artifacts: [],
    context: { labels: ["synthetic-staging-canary", "synthetic", "not-a-real-meeting"], metadata: { synthetic: true, purpose: "release-approval-rehearsal" } },
  };
  return {
    schema_version: 1,
    id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1,
    ...body,
    provenance: {
      source: { kind: "meeting-source", adapter_id: STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1, instance_id: "staging-synthetic", version: VERSION },
      external_id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1,
      canonical_revision: canonicalSha256({ kind: "echo-staging-synthetic-canary-meeting-v1", body } as never),
      observed_at: "2026-10-07T00:00:00.000Z",
      normalizer_version: NORMALIZER_VERSION,
      metadata: { synthetic: true, environment: "staging" },
    },
  };
}

/**
 * Reads every `*.json` meeting in a fixture directory, in file-name order.
 * Entries must be bounded regular files holding canonical meeting documents
 * with distinct ids; the canary id is reserved.
 */
export async function readStagingSyntheticMeetingFixturesV1(directory: string): Promise<readonly MeetingDocument[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name.endsWith(".json"))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (entries.length === 0 || entries.length > MAXIMUM_FIXTURES) throw new Error(`staging synthetic fixtures must hold 1 to ${MAXIMUM_FIXTURES} meeting files`);
  const meetings: MeetingDocument[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (!entry.isFile() || !metadata.isFile() || metadata.size < 1 || metadata.size > MAXIMUM_FIXTURE_BYTES) {
      throw new Error("staging synthetic fixtures must be bounded regular files");
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    assertCanonicalMeetingDocument(parsed);
    if (!MEETING_ID.test(parsed.id) || parsed.id === STAGING_SYNTHETIC_CANARY_MEETING_ID_V1 || meetings.some(meeting => meeting.id === parsed.id)) {
      throw new Error("staging synthetic fixture meeting ids must be distinct lowercase ids");
    }
    meetings.push(parsed);
  }
  return Object.freeze(meetings);
}

function notes(meeting: MeetingDocument): string {
  return meeting.content.filter(block => block.kind !== "transcript").map(block => block.text).join("\n\n");
}

/**
 * The staging-only synthetic personal meeting provider: the fixed release
 * canary plus, when given, each fixture meeting. Its shape is the Authority's
 * `PersonMeetingProviderV1`; provider packages cannot import the service, so
 * the composition root checks it there.
 */
export function createStagingSyntheticPersonalMeetingProviderV1(options: {
  readonly fixtures_directory?: string;
}) {
  let fixtures: Promise<readonly MeetingDocument[]> | undefined;
  const loadFixtures = () => options.fixtures_directory === undefined ? Promise.resolve([]) :
    (fixtures ??= readStagingSyntheticMeetingFixturesV1(options.fixtures_directory).catch((error: unknown) => { fixtures = undefined; throw error; }));
  const meeting = async (id: string): Promise<MeetingDocument | undefined> =>
    id === STAGING_SYNTHETIC_CANARY_MEETING_ID_V1 ? canaryMeeting() : (await loadFixtures()).find(fixture => fixture.id === id);
  const connection_http: ProviderHttpApplicationV1 = Object.freeze({
    routes: [],
    async accept() { throw new AuthorityOperationError("not_found", "Synthetic meeting route unavailable"); },
  });
  return Object.freeze({
    id: STAGING_SYNTHETIC_TOOL_ID_V1,
    normalizer_version: NORMALIZER_VERSION,
    custodian_assurance: STAGING_SYNTHETIC_CUSTODIAN_ASSURANCE_V1,
    connection_http,
    cursor: Object.freeze({ read: readStagingSyntheticCheckpointV1, write: writeStagingSyntheticCheckpointV1, policy: CURSOR_POLICY }),
    tool(_token: string) {
      return { tool_id: STAGING_SYNTHETIC_TOOL_ID_V1, display_name: "Synthetic staging meetings", availability: "enabled" as const,
        personal_status: "linked" as const, external_scope_id: null, external_subject_id: "staging-synthetic", organization_setup: null };
    },
    async open(person: { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }, current: () => void, signal?: AbortSignal) {
      signal?.throwIfAborted(); current();
      const identity = { kind: "meeting-source" as const, adapter_id: STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1, version: VERSION,
        instance_id: `staging-synthetic-${canonicalSha256({ organization_id: person.organization_id, principal_id: person.principal_id, membership_id: person.membership_id }).slice(7)}` };
      return {
        identity, custodian: { kind: "echo-staging-synthetic-custodian-v1", person: identity.instance_id },
        email: "staging-synthetic@example.test", workspace: "Synthetic staging meetings", current,
        async folders(): Promise<readonly { readonly id: string; readonly title: string; readonly count: number }[]> { return []; },
        async browse(_folder: string): Promise<{ readonly meetings: readonly { readonly id: string; readonly title: string; readonly date: string }[] }> {
          throw new AuthorityOperationError("not_found", "Synthetic meetings have no folders");
        },
        async preview(id: string) {
          const found = await meeting(id);
          current();
          if (found === undefined) throw new AuthorityOperationError("not_found", "Synthetic meeting unavailable");
          const text = notes(found);
          return { id: found.id, title: (found.title ?? "Synthetic meeting").slice(0, 256), notes: text.slice(0, 8_000), summary: "", truncated: text.length > 8_000 };
        },
      };
    },
    source(setting: { readonly source_adapter_id: string; readonly source_adapter_version: string; readonly source_adapter_instance_id: string },
      current: () => void): MeetingSourceAdapter & { requireCurrent(): void } {
      const identity = { kind: "meeting-source" as const, adapter_id: setting.source_adapter_id, instance_id: setting.source_adapter_instance_id, version: setting.source_adapter_version };
      if (identity.adapter_id !== STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1 || identity.version !== VERSION) throw new Error("staging synthetic source identity differs");
      return {
        identity,
        validateConfig: (config: AdapterConfig) => config.adapter_id === identity.adapter_id && config.instance_id === identity.instance_id
          ? { ok: true, errors: [] } : { ok: false, errors: ["staging synthetic source identity differs"] },
        healthCheck: async () => ({ status: "healthy" as const, checked_at: new Date().toISOString(), message: "staging synthetic meetings" }),
        requireCurrent: current,
        async pull(request) {
          current();
          const checkpoint = readStagingSyntheticCheckpointV1(request.cursor ?? writeStagingSyntheticCheckpointV1({ folder: null, baseline: false, revisions: {}, manual: [] }));
          const id = checkpoint.manual[0];
          if (id === undefined) return { meetings: [] };
          const found = await meeting(id);
          if (found === undefined) throw new AdapterError("permanently_rejected", "staging synthetic meeting is not available to this runtime", false);
          current();
          return { meetings: [{ ...found, provenance: { ...found.provenance, source: identity } }],
            next_cursor: writeStagingSyntheticCheckpointV1({ ...checkpoint, manual: checkpoint.manual.slice(1) }) };
        },
      };
    },
  });
}
