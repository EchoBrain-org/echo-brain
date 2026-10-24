import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { createGranolaPersonConnectionV1 } from '@echo-brain/provider-granola/granola-person-connection-v1';
import { GRANOLA_PERSON_PROVIDER_V1 } from '@echo-brain/provider-granola/granola-mcp-v1';
import { GRANOLA_MEETING_NORMALIZER_VERSION_V1 } from '@echo-brain/provider-granola/granola-meeting-normalizer-v1';
import { GranolaWatchSourceV1, GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1, GRANOLA_WATCH_CURSOR_POLICY_V1 } from '@echo-brain/provider-granola/granola-watch-source-v1';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { createPersonConnectionHttpApplicationV1 } from '@echo-brain/provider-runtime/person-connection-http-application-v1';
import { createNangoPersonConnectionV1, type NangoPersonConnectionV1 } from '@echo-brain/provider-runtime/nango-person-connection-v1';
import { meetingIntakePersonV1, type PersonMeetingProviderV1 } from './person-meeting-runtime-v1.js';
import { personToolAuthenticationV1 } from './person-tool-authentication-v1.js';
import { bindPersonProviderStateV1, openPersonProviderDatabaseV1 } from './person-provider-state-v1.js';
import type { PersonHttpRuntimeResourcesV1 } from './organization-authority-api-runtime.js';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';

/** How browsing names a note Granola keeps untitled. */
const UNTITLED = 'Untitled meeting';
/** Only this selecting bootstrap knows Granola; it opens the Granola connections and returns one meeting provider. */
export function openGranolaPersonMeetingProviderV1(options: {
  readonly state_directory: string; readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  readonly resources: Pick<PersonHttpRuntimeResourcesV1, 'coordinates'>; readonly nango_authorization: () => string;
  readonly seams?: { readonly database?: Database.Database; readonly nango?: NangoPersonConnectionV1; readonly fetch?: typeof fetch };
}): { readonly provider: PersonMeetingProviderV1; close(): void } {
  const { coordinates } = options.resources;
  const opened = openPersonProviderDatabaseV1(join(options.state_directory, 'granola-person-connections.sqlite'), {
    ...(options.seams?.database === undefined ? {} : { supplied: options.seams.database }),
    bind: database => bindPersonProviderStateV1(database, 'authority_granola_person_live_binding_v1', { schema_version: 1, ...coordinates, integration_id: 'granola-mcp' }, 'Granola state differs from the Authority lineage or integration'),
  });
  const connections = opened.database;
  try {
    const transport = options.seams?.fetch ?? fetch;
    const application = createGranolaPersonConnectionV1({ store: new PersonConnectionStoreV1(connections, GRANOLA_PERSON_PROVIDER_V1),
      nango: options.seams?.nango ?? createNangoPersonConnectionV1({ provider: GRANOLA_PERSON_PROVIDER_V1, integration_id: 'granola-mcp', authorization: options.nango_authorization, fetch: transport }),
      fetch: transport, authenticate: personToolAuthenticationV1(options.sessions) });
    const provider: PersonMeetingProviderV1 = {
      id: 'granola', normalizer_version: GRANOLA_MEETING_NORMALIZER_VERSION_V1,
      connection_http: createPersonConnectionHttpApplicationV1(application, GRANOLA_PERSON_PROVIDER_V1),
      cursor: { ...GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1, policy: GRANOLA_WATCH_CURSOR_POLICY_V1 },
      tool: token => application.tool({ access_token: token }),
      async open(person, current, signal) {
        const session = await application.open(person, current, signal);
        return { identity: session.identity, custodian: { email: session.account.email, workspace: session.account.workspace_id },
          email: session.account.email, workspace: session.account.workspace_name, current: session.current,
          async folders() { const folders = await session.api.folders(signal); await session.verify(); return folders.map(f => ({ id: f.id, title: f.title.slice(0, 128), count: f.note_count })); },
          async browse(folder) { return { meetings: (await session.recent(folder)).map(m => ({ id: m.id, title: (m.title ?? UNTITLED).slice(0, 256), date: m.date })) }; },
          watchable: watch => session.watchable(watch),
          async preview(meeting) { const detail = await session.api.meeting(meeting, signal); await session.verify();
            const notes = detail.private_notes ?? '', summary = detail.summary ?? '';
            return { id: detail.id, title: (detail.title ?? UNTITLED).slice(0, 256), notes: notes.slice(0, 8_000), summary: summary.slice(0, 8_000), truncated: notes.length > 8_000 || summary.length > 8_000 };
          },
        };
      },
      source(setting, current) { return new GranolaWatchSourceV1({ kind: 'meeting-source', adapter_id: setting.source_adapter_id, version: setting.source_adapter_version, instance_id: setting.source_adapter_instance_id },
        { watch: setting.watch, folder_id: setting.folder_id }, signal => application.open(meetingIntakePersonV1(setting), current, signal), current); },
    };
    return { provider, close() { opened.close(); } };
  } catch (error) { opened.close(); throw error; }
}
