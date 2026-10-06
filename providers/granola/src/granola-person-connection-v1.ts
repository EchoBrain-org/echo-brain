import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { createPersonConnectionLifecycleV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import type { ConnectedPersonV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createGranolaMcpV1, GRANOLA_PERSON_PROVIDER_V1, granolaMcpMeetingContentV1 } from './granola-mcp-v1.js';
import { normalizeGranolaMeetingV1 } from './granola-meeting-normalizer-v1.js';
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
    return Object.freeze({ ...session, api, account, identity, verify,
      async read(meetingId: string) {
        const detail = await api.meeting(meetingId, signal);
        const transcript = await api.transcript(meetingId, signal);
        await verify();
        return normalizeGranolaMeetingV1(granolaMcpMeetingContentV1(detail, transcript), identity, new Date().toISOString());
      },
      /** All-time folder enumeration must equal the provider's advertised membership count. */
      async folder(folderId: string) {
        const folders = await api.folders(signal);
        const folder = folders.find(item => item.id === folderId);
        if (folder === undefined) fail('not_found');
        if (folder.note_count > 50) GRANOLA_PERSON_PROVIDER_V1.failure('unavailable');
        const meetings = await api.meetings({ folder_id: folderId, since: '1970-01-01', until: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), signal });
        if (meetings.length !== folder.note_count) GRANOLA_PERSON_PROVIDER_V1.failure('unavailable');
        await verify();
        return Object.freeze({ folder, meetings });
      },
    });
  }
  async function request(accessToken: string, signal?: AbortSignal) {
    const actor = shared.actor(accessToken);
    return open(actor.person, actor.requirePerson, signal);
  }
  return Object.freeze({ ...shared.application, open, request });
}
export type GranolaPersonConnectionV1 = ReturnType<typeof createGranolaPersonConnectionV1>;
