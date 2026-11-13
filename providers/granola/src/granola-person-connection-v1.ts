import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { randomUUID } from 'node:crypto';
import { createPersonProjectMappingAccessV1, PersonProjectMappingStoreV1, type PersonProjectAuthorizationV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { validatePersonMeetingProjectMappingV1, validatePersonMeetingProjectReadV1, validatePersonMeetingProjectSetV1, validatePersonMeetingFoldersPageV1, type PersonMeetingProjectMappingV1 } from '@echo-brain/organization-api';
import type { PersonPageCitationV1 } from '@echo-brain/organization-api';
import type { PersonLiveEvidenceAuditV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createGranolaPersonLiveEvidenceReaderV1 } from './granola-person-live-evidence-reader-v1.js';
import { createPersonConnectionLifecycleV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import type { ConnectedPersonV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createGranolaMcpV1, GRANOLA_ID_V1, GRANOLA_PERSON_PROVIDER_V1, granolaMeetingUnreadableV1, type GranolaMeetingV1 } from './granola-mcp-v1.js';
import { granolaWatchWindowV1, type GranolaWatchV1 } from './granola-watch-source-v1.js';
const fail: typeof GRANOLA_PERSON_PROVIDER_V1.failure = GRANOLA_PERSON_PROVIDER_V1.failure;

/** Verified MCP acquisition. Retention, watch checkpoints, extraction and review belong to Authority. */
export function createGranolaPersonConnectionV1(options: Omit<Parameters<typeof createPersonConnectionLifecycleV1>[0], 'provider' | 'scope_id' | 'verify'> & {
  readonly project_mappings?: PersonProjectMappingStoreV1<PersonMeetingProjectMappingV1>; readonly authorize_project?: PersonProjectAuthorizationV1;
}) {
  const shared = createPersonConnectionLifecycleV1({ ...options, provider: GRANOLA_PERSON_PROVIDER_V1,
    async verify(transport, input) {
      const account = await createGranolaMcpV1(transport).account(input.signal);
      input.require_account(account.email);
      return { account_id: account.email, scope_id: account.workspace_id, origin: 'https://mcp.granola.ai' };
    },
  });
  async function open(person: ConnectedPersonV1, requirePerson: () => void, signal?: AbortSignal) {
    const session = shared.open(person, requirePerson, signal);
    const api = createGranolaMcpV1(session.transport);
    async function verify() {
      session.current();
      const account = await api.account(signal);
      if (account.email !== session.stored.binding.external_subject_id || account.workspace_id !== session.stored.binding.external_scope_id) {
        // Scope drift is terminal for this grant, including in-flight imports.
        options.store.revoke(person);
        GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
      }
      session.current(); return account;
    }
    const account = await verify();
    const identity = Object.freeze({ kind: 'meeting-source' as const, adapter_id: 'granola-person-mcp', version: '1.0.0',
      instance_id: `granola-${canonicalSha256({ person, account: account.email, workspace: account.workspace_id }).slice(7)}`,
    });
    /** Every meeting of a watch's window: the ones the person captured, or one folder's. Past 200 it fails closed. */
    async function windowed(input: { readonly mode: 'mine' | 'folder'; readonly folder: string | null; readonly from_date: string; readonly to_date: string }) {
      if ((input.mode === 'folder') !== (input.folder !== null)) fail('invalid_request');
      const meetings = await api.meetings({ from_date: input.from_date, to_date: input.to_date,
        ...(input.folder === null ? { captured_by_me: true as const } : { folder_id: input.folder }), signal });
      await verify();
      return meetings;
    }
    return Object.freeze({ ...session, api, account, identity, verify, window: windowed,
      /** The newest meetings, at most 50: the ones the person captured, or one of their listed folders'. */
      async recent(folderId: string | null) {
        if (folderId !== null && !(await api.folders(signal)).some(folder => folder.id === folderId)) fail('not_found');
        const { meetings } = await api.page({ from_date: '1970-01-01', to_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), limit: 50,
          ...(folderId === null ? { captured_by_me: true as const } : { folder_id: folderId }), signal });
        await verify();
        return meetings;
      },
      /**
       * A watch checked at Save with the listing its worker uses: a folder the person no longer lists, or a window over
       * 200 meetings, refuses it now rather than failing every later pull.
       */
      async watchable(watch: GranolaWatchV1) {
        if (watch.watch === 'off') fail('invalid_request');
        if (watch.folder_id !== null && !(await api.folders(signal)).some(folder => folder.id === watch.folder_id)) fail('not_found');
        await windowed({ mode: watch.watch, folder: watch.folder_id, ...granolaWatchWindowV1(Date.now()) });
      },
    });
  }
  const access = createPersonProjectMappingAccessV1(GRANOLA_PERSON_PROVIDER_V1, options);
  const cursors = new Map<string, { offset: number; digest: string }>();
  function scopeId(access_token: string): string | undefined {
    const { person } = shared.actor(access_token), stored = options.store.current(person);
    return stored?.active ? stored.binding.external_scope_id ?? undefined : undefined;
  }
  return Object.freeze({ ...shared.application, open, scopeId,
    projectRead: (input: { readonly access_token: string; readonly request: unknown }) => access.read({ lifecycle: shared, validate: validatePersonMeetingProjectReadV1 }, input),
    projectSet: (input: { readonly access_token: string; readonly request: unknown; readonly signal?: AbortSignal }) => access.set({
      lifecycle: shared, validate: validatePersonMeetingProjectSetV1, selection: request => request.folder_ids,
      async resolve(folder_ids, connection, signal) {
        const api = createGranolaMcpV1(connection.transport), account = await api.account(signal);
        if (account.workspace_id !== connection.stored.binding.external_scope_id || account.email !== connection.stored.binding.external_subject_id) fail('stale_access_state');
        const visible = new Set((await api.folders(signal)).map(folder => folder.id));
        if (folder_ids.some(id => !visible.has(id))) fail('unauthorized');
        connection.current();
        return { cloud_id: account.workspace_id, folder_ids: [...folder_ids] };
      },
    }, input),
    async foldersList(input: { readonly access_token: string; readonly cursor?: string; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = shared.actor(input.access_token), session = await open(person, requirePerson, input.signal);
      const folders = await session.api.folders(input.signal);
      const digest = canonicalSha256({ binding: session.stored.binding, folders });
      const previous = input.cursor === undefined ? undefined : cursors.get(input.cursor);
      if (input.cursor !== undefined && (previous === undefined || previous.digest !== digest)) fail('stale_access_state');
      const offset = previous?.offset ?? 0;
      let next_cursor: string | null = null;
      if (offset + 20 < folders.length) {
        if (cursors.size >= 512) cursors.delete(cursors.keys().next().value!);
        next_cursor = randomUUID(); cursors.set(next_cursor, { offset: offset + 20, digest });
      }
      await session.verify();
      return validatePersonMeetingFoldersPageV1({ schema_version: 1, items: folders.slice(offset, offset + 20).map(folder => ({ id: folder.id, key: folder.id,
        name: folder.title.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, 256) || 'Untitled folder' })), next_cursor });
    },
    async source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonPageCitationV1>; readonly signal?: AbortSignal }) {
      const scope_id = scopeId(input.access_token);
      if (scope_id === undefined) return undefined;
      // Each person has their own workspace: a project mapped in another one is no Granola source for this asker.
      return access.source({ scope_id, other_site: 'none', validate: validatePersonMeetingProjectReadV1, lifecycle: shared, store: options.store,
        reader: ({ fetch: transport, signal }, mapping) => createGranolaPersonLiveEvidenceReaderV1({ transport, signal,
          ...(mapping === undefined ? {} : { folder_ids: mapping.folder_ids }) }),
      }, input);
    },
    async pageVersions(input: { readonly access_token: string; readonly page_ids: readonly string[]; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = shared.actor(input.access_token), session = await open(person, requirePerson, input.signal);
      const result = new Map<string, string>();
      const gone = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'not_found' || error.code === 'unauthorized');
      const read = (meeting: GranolaMeetingV1) => result.set(meeting.id, meeting.updated_at ?? canonicalSha256(meeting));
      // A cited id that is no Granola id is simply not readable; it never fails the check.
      const pages = [...new Set(input.page_ids)].slice(0, 100).filter(page => GRANOLA_ID_V1.test(page));
      for (let at = 0; at < pages.length; at += 10) {
        const batch = pages.slice(at, at + 10);
        try { (await session.api.present(batch, input.signal)).forEach(read); }
        catch (error) {
          if (gone(error)) continue;
          if (!granolaMeetingUnreadableV1(error)) throw error;
          // One unusable meeting fails its batch's answer: read that batch one by one so it hides only itself.
          for (const page of batch) {
            try { read(await session.api.meeting(page, input.signal)); }
            catch (inner) { if (!gone(inner) && !granolaMeetingUnreadableV1(inner)) throw inner; }
          }
        }
      }
      await session.verify(); return result;
    },
  });
}
export type GranolaPersonConnectionV1 = ReturnType<typeof createGranolaPersonConnectionV1>;

export function createGranolaProjectMappingStoreV1(database: ConstructorParameters<typeof PersonProjectMappingStoreV1>[0]) {
  return new PersonProjectMappingStoreV1(database, GRANOLA_PERSON_PROVIDER_V1, validatePersonMeetingProjectMappingV1);
}
