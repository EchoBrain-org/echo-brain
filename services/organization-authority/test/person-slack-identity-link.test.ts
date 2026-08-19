import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  organizationSlackLinkChallengeCodeSha256,
} from '@echo-brain/organization-api';
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  OrganizationIntegrationsRepository,
  openOrganizationControlDatabase,
  type OrganizationSecretStore,
  type SlackIntegrationProvider,
} from '@echo-brain/organization-control-plane';
import { describe, expect, it, vi } from 'vitest';
import type { PersonAccessAuthorization } from '../src/application/person-identity-sessions.js';
import { PersonSlackIdentityLinkService } from '../src/composition/person-slack-identity-link.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import { AuthorityOperationError } from '../src/domain/errors.js';

const NOW = '2026-08-18T12:00:00.000Z';
const AUTHORITY_ID = 'oau_11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = 'org_22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = 'prn_33333333-3333-4333-8333-333333333333';
const MEMBERSHIP_ID = 'mem_44444444-4444-4444-8444-444444444444';
const CODE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'server-held-slack-token';
const ACCESS_TOKEN = 'person-access-token';

const AUTHORIZATION: PersonAccessAuthorization = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'employee',
  identity_binding_id: 'oib_55555555-5555-4555-8555-555555555555',
  session_family_id: 'psf_66666666-6666-4666-8666-666666666666',
  access_credential_sha256: canonicalSha256('access'),
  access_expires_at: '2026-08-19T00:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
  person_state_sha256: canonicalSha256('person-state'),
  session_state_sha256: canonicalSha256('session-state'),
  checked_at: NOW,
};

function beginRequest() {
  return {
    schema_version: 2,
    kind: 'echo-organization-person-slack-link-begin-request',
    request_id: 'psb_77777777-7777-4777-8777-777777777777',
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    subject_principal_id: PRINCIPAL_ID,
    http_method: 'POST',
    http_path: ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
    challenge_code_sha256: organizationSlackLinkChallengeCodeSha256(CODE),
  } as const;
}

function completeRequest(challengeAttemptId: string, challengeMessageTs: string) {
  return {
    schema_version: 2,
    kind: 'echo-organization-person-slack-link-complete-request',
    request_id: 'psc_88888888-8888-4888-8888-888888888888',
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    subject_principal_id: PRINCIPAL_ID,
    http_method: 'POST',
    http_path: ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
    challenge_attempt_id: challengeAttemptId,
    challenge_message_ts: challengeMessageTs,
    challenge_code: CODE,
  } as const;
}

function openRepository(): OrganizationIntegrationsRepository {
  const database = openOrganizationControlDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_99999999-9999-4999-8999-999999999999', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, canonicalSha256('authority'), NOW);
  const repository = new OrganizationIntegrationsRepository(database, {
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
  });
  repository.onboardSlackOrganizationTool({
    command_id: 'adm_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    command_sha256: canonicalSha256('onboard'),
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
    administrator_principal_id: PRINCIPAL_ID,
    administrator_membership_id: MEMBERSHIP_ID,
    connection: {
      team_id: 'T123ABC',
      enterprise_id: null,
      bot_user_id: 'U123BOT',
      bot_id: 'B123BOT',
      app_id: 'A123APP',
      granted_scopes: [
        'channels:history',
        'channels:read',
        'chat:write',
        'reactions:read',
        'users:read',
      ],
      verification_evidence_sha256: canonicalSha256('connection'),
    },
    channel: {
      channel_id: 'C123ABC',
      team_id: 'T123ABC',
      verification_evidence_sha256: canonicalSha256('channel'),
    },
    secret: {
      secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
      secret_handle_id: 'sch_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    now: NOW,
  });
  return repository;
}

function fixture(options: {
  authorization?: () => PersonAccessAuthorization;
  onObserve?: () => void;
} = {}) {
  const repository = openRepository();
  const secrets: OrganizationSecretStore = {
    create: vi.fn(),
    read: vi.fn(() => TOKEN),
    listReferences: vi.fn(() => []),
    remove: vi.fn(),
  };
  const slack: SlackIntegrationProvider = {
    verifyConnection: vi.fn(async (token) => {
      expect(token).toBe(TOKEN);
      return {
        team_id: 'T123ABC',
        enterprise_id: null,
        bot_user_id: 'U123BOT',
        bot_id: 'B123BOT',
        app_id: 'A123APP',
        granted_scopes: [
          'channels:history',
          'channels:read',
          'chat:write',
          'reactions:read',
          'users:read',
        ],
        verification_evidence_sha256: canonicalSha256('connection'),
      };
    }),
    verifyChannel: vi.fn(async (token) => {
      expect(token).toBe(TOKEN);
      return {
        channel_id: 'C123ABC',
        team_id: 'T123ABC',
        verification_evidence_sha256: canonicalSha256('channel'),
      };
    }),
    verifyHuman: vi.fn(async () => {
      throw new Error('Person identity linking observes the challenge instead');
    }),
    verifyReaction: vi.fn(async () => {
      throw new Error('Person identity linking does not verify a reaction');
    }),
    postIdentityLinkChallenge: vi.fn(async (token) => {
      expect(token).toBe(TOKEN);
      return {
        team_id: 'T123ABC',
        channel_id: 'C123ABC',
        challenge_message_ts: '1755518400.000001',
      };
    }),
    observeIdentityLinkChallenge: vi.fn(async (token, input) => {
      expect(token).toBe(TOKEN);
      options.onObserve?.();
      return {
        team_id: 'T123ABC',
        user_id: 'U123PERSON',
        channel_id: 'C123ABC',
        challenge_message_ts: input.challenge_message_ts,
        reply_message_ts: '1755518401.000001',
        verification_evidence_sha256: canonicalSha256('observation'),
      };
    }),
  };
  const authenticateAccess = vi.fn(
    options.authorization ?? (() => AUTHORIZATION),
  );
  return {
    repository,
    secrets,
    slack,
    authenticateAccess,
    application: new PersonSlackIdentityLinkService({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      authentication: { authenticateAccess },
      repository,
      secrets,
      slack,
      authorization_fence: new ReadableSearchAuthorizationFence(),
      now: () => NOW,
    }),
  };
}

async function begin(context: ReturnType<typeof fixture>) {
  return await context.application.begin(beginRequest(), ACCESS_TOKEN);
}

describe('PersonSlackIdentityLinkService', () => {
  it('runs the fake-provider flow and creates only a Person identity link', async () => {
    const context = fixture();
    const begun = await begin(context);
    const request = completeRequest(
      begun.challenge_attempt_id,
      begun.challenge_message_ts,
    );
    const result = await context.application.complete(request, ACCESS_TOKEN);

    expect(result).toMatchObject({
      schema_version: 2,
      kind: 'echo-organization-person-slack-link-result',
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      provider_subject_id: 'U123PERSON',
      identity_link_created: true,
    });
    expect(result).not.toHaveProperty('installation_id');
    expect(result).not.toHaveProperty('adapter_binding_id');
    expect(result).not.toHaveProperty('permission_grants_created');
    const overview = context.repository.overview();
    expect(overview.identity_links).toHaveLength(1);
    expect(overview.adapter_bindings).toEqual([]);
    expect(overview.permission_grants).toEqual([]);
    expect(JSON.stringify({ request, result })).not.toContain(TOKEN);
  });

  it('replays completion without calling Slack or appending another audit row', async () => {
    const context = fixture();
    const begun = await begin(context);
    const request = completeRequest(
      begun.challenge_attempt_id,
      begun.challenge_message_ts,
    );
    const first = await context.application.complete(request, ACCESS_TOKEN);
    const auditCount = context.repository.overview().recent_audit.length;
    const second = await context.application.complete(request, ACCESS_TOKEN);
    expect(second).toEqual(first);
    expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledTimes(1);
    expect(context.repository.overview().recent_audit).toHaveLength(auditCount);
  });

  it('denies a caller/subject mismatch before any Slack call', async () => {
    const context = fixture();
    await expect(
      context.application.begin(
        {
          ...beginRequest(),
          subject_principal_id:
            'prn_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        },
        ACCESS_TOKEN,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(context.slack.verifyConnection).not.toHaveBeenCalled();
  });

  it('rechecks the Person after Slack observation and commits nothing after revocation', async () => {
    let revoked = false;
    const context = fixture({
      authorization: () => {
        if (revoked) {
          throw new AuthorityOperationError(
            'unauthorized',
            'Person session is unauthorized',
          );
        }
        return AUTHORIZATION;
      },
      onObserve: () => {
        revoked = true;
      },
    });
    const begun = await begin(context);
    await expect(
      context.application.complete(
        completeRequest(
          begun.challenge_attempt_id,
          begun.challenge_message_ts,
        ),
        ACCESS_TOKEN,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(context.repository.overview().identity_links).toEqual([]);
  });
});
