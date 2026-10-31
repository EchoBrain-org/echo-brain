import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { createPersonConnectionLifecycleV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import type { ConnectedPersonV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createGranolaMcpV1, GRANOLA_PERSON_PROVIDER_V1 } from './granola-mcp-v1.js';
import { granolaWatchWindowV1, type GranolaWatchV1 } from './granola-watch-source-v1.js';
const fail: typeof GRANOLA_PERSON_PROVIDER_V1.failure = GRANOLA_PERSON_PROVIDER_V1.failure;

/** Verified MCP acquisition. Retention, watch checkpoints, extraction and review belong to Authority. */
export function createGranolaPersonConnectionV1(options: Omit<Parameters<typeof createPersonConnectionLifecycleV1>[0], 'provider' | 'scope_id' | 'verify'>) {
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
  return Object.freeze({ ...shared.application, open });
}
export type GranolaPersonConnectionV1 = ReturnType<typeof createGranolaPersonConnectionV1>;
