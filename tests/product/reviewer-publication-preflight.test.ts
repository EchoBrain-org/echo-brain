import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterConfig, ApprovalRequest } from '@echo-brain/organization-authority/processing/core/index.js';
import {
  assertReviewerPublicationPreflight,
  createDefaultAdapterFactories,
  DecisionNodeStore,
  decisionApprovalId,
  reviewerApprovalPresentationRenderer,
  reviewerPublicationPreflight,
  type OrganizationMemberSlackApprovalPresentationContract,
  type ReviewerPublicationConfiguration,
  type SlackApprovalPresentationContract,
  type UnresolvedApprovalPresentationSlot,
} from '../../src/product/index.js';
import {
  organizationMemberApprovalPolicyContractSha256,
} from '../../src/product/organization/record/adapters/organization-member-presentation-renderer.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function contract(
  overrides: Partial<SlackApprovalPresentationContract> = {},
): SlackApprovalPresentationContract {
  return {
    schema_version: 1,
    kind: 'echo-slack-approval-presentation-contract',
    mode: 'restricted-reviewer-v1',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'default',
    adapter_version: '1.0.0',
    channel_id: 'C012CHANNEL',
    reviewer_slack_user_id: 'U012REVIEWER',
    reviewer_name: 'Reviewer One',
    credential_ref: 'env:ECHO_SLACK_BOT_TOKEN',
    credential_fingerprint_sha256: digest('1'),
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    reviewer_release_draft_sha256: digest('2'),
    approval_presentation_sha256: digest('3'),
    ...overrides,
  };
}

function configuration(
  overrides: Partial<ReviewerPublicationConfiguration> = {},
): ReviewerPublicationConfiguration {
  return {
    mode: 'restricted-reviewer-v1',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'default',
    adapter_version: '1.0.0',
    channel_id: 'C012CHANNEL',
    reviewer_slack_user_id: 'U012REVIEWER',
    reviewer_name: 'Reviewer One',
    credential_ref: 'env:ECHO_SLACK_BOT_TOKEN',
    credential_fingerprint_sha256: digest('1'),
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    permission_pilot_presentation_enabled: false,
    ...overrides,
  };
}

const reviewerSlot: UnresolvedApprovalPresentationSlot = {
  approval_id: 'a'.repeat(64),
  contract: contract(),
};

function organizationMemberContract(
  overrides: Partial<OrganizationMemberSlackApprovalPresentationContract> = {},
): OrganizationMemberSlackApprovalPresentationContract {
  return {
    schema_version: 1,
    kind: 'echo-slack-approval-presentation-contract',
    mode: 'organization-member-readable-v1',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'default',
    adapter_version: '1.0.0',
    channel_id: 'C012CHANNEL',
    reviewer_slack_user_id: 'U012REVIEWER',
    reviewer_name: 'Reviewer One',
    credential_ref: 'env:SLACK_BOT_TOKEN',
    credential_fingerprint_sha256: reviewerApprovalPresentationRenderer
      .credentialFingerprint('xoxb-test'),
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: organizationMemberApprovalPolicyContractSha256(),
    release_draft_sha256: digest('2'),
    approval_presentation_sha256: digest('3'),
    ...overrides,
  };
}

const organizationMemberSlot: UnresolvedApprovalPresentationSlot = {
  approval_id: 'd'.repeat(64),
  contract: organizationMemberContract(),
};

describe('reviewer publication preflight', () => {
  it('accepts an unchanged configuration with unresolved reviewer cards', () => {
    expect(
      reviewerPublicationPreflight(configuration(), [reviewerSlot]),
    ).toEqual({ ok: true, refusals: [] });
    expect(() =>
      assertReviewerPublicationPreflight(configuration(), [reviewerSlot]),
    ).not.toThrow();
  });

  it('refuses enabling reviewer mode over an unresolved non-reviewer card', () => {
    const ordinary: UnresolvedApprovalPresentationSlot = {
      approval_id: 'b'.repeat(64),
      contract: null,
    };
    const result = reviewerPublicationPreflight(configuration(), [ordinary]);
    expect(result.ok).toBe(false);
    expect(result.refusals[0]).toContain(
      'published without a frozen approval presentation contract',
    );
    // Resolved history needs no rewrite: an empty unresolved set is clean.
    expect(reviewerPublicationPreflight(configuration(), []).ok).toBe(true);
  });

  it('refuses enabling organization-member mode over a contract-less Authority card', () => {
    const result = reviewerPublicationPreflight(
      configuration({ mode: 'organization-member-readable-v1' }),
      [{ approval_id: 'b'.repeat(64), contract: null }],
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.join('; ')).toContain(
      'published without a frozen approval presentation contract',
    );
  });

  it('refuses pilot and reviewer presentation configuration together', () => {
    const result = reviewerPublicationPreflight(
      configuration({ permission_pilot_presentation_enabled: true }),
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.refusals).toContain(
      'restricted-reviewer-v1 and the permission pilot presentation are mutually exclusive',
    );
  });

  it('refuses every in-place rotation until the frozen card drains', () => {
    const rotations: [Partial<ReviewerPublicationConfiguration>, string][] = [
      [{ adapter_id: 'slack-other' }, 'adapter_id'],
      [{ adapter_instance_id: 'second' }, 'adapter_instance_id'],
      [{ adapter_version: '2.0.0' }, 'adapter_version'],
      [{ channel_id: 'C099OTHER' }, 'channel_id'],
      [{ reviewer_slack_user_id: 'U099OTHER' }, 'reviewer_slack_user_id'],
      [{ reviewer_name: 'Reviewer Two' }, 'reviewer_name'],
      [{ credential_ref: 'env:OTHER_TOKEN' }, 'credential_ref'],
      [{ approve_reaction: 'heavy_check_mark' }, 'approve_reaction'],
      [{ reject_reaction: 'no_entry' }, 'reject_reaction'],
    ];
    for (const [rotation, field] of rotations) {
      const result = reviewerPublicationPreflight(configuration(rotation), [
        reviewerSlot,
      ]);
      expect(result.ok, field).toBe(false);
      expect(
        result.refusals.some((refusal) => refusal.includes(`froze ${field}`)),
        field,
      ).toBe(true);
    }
  });

  it('refuses an in-place credential value rotation and an unresolvable value', () => {
    for (const fingerprint of [digest('9'), null]) {
      const result = reviewerPublicationPreflight(
        configuration({ credential_fingerprint_sha256: fingerprint }),
        [reviewerSlot],
      );
      expect(result.ok).toBe(false);
      expect(
        result.refusals.some((refusal) =>
          refusal.includes('froze its credential value'),
        ),
      ).toBe(true);
    }
  });

  it('refuses starting an unresolved reviewer card under another mode', () => {
    for (const mode of ['ordinary-v1', 'pilot-member-readable-v1'] as const) {
      const result = reviewerPublicationPreflight(configuration({ mode }), [
        reviewerSlot,
      ]);
      expect(result.ok).toBe(false);
      expect(result.refusals[0]).toContain(`cannot start under ${mode}`);
    }
  });

  it('refuses every non-v3 start over an unresolved schema-v3 card', () => {
    for (const mode of [
      'ordinary-v1',
      'pilot-member-readable-v1',
      'restricted-reviewer-v1',
    ] as const) {
      const result = reviewerPublicationPreflight(
        configuration({ mode }),
        [organizationMemberSlot],
      );
      expect(result.ok, mode).toBe(false);
      expect(result.refusals.join('; '), mode).toContain(
        `cannot start under ${mode}`,
      );
    }
  });

  it('refuses an unresolved schema-v3 card with a substituted policy digest', () => {
    const result = reviewerPublicationPreflight(
      configuration({
        mode: 'organization-member-readable-v1',
        organization_member_policy_contract_sha256:
          organizationMemberApprovalPolicyContractSha256(),
      }),
      [
        {
          ...organizationMemberSlot,
          contract: organizationMemberContract({
            policy_contract_sha256: digest('f'),
          }),
        },
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.join('; ')).toContain('policy contract digest');
  });

  it('aggregates every refusal into one thrown startup failure', () => {
    expect(() =>
      assertReviewerPublicationPreflight(
        configuration({ channel_id: 'C099OTHER', approve_reaction: 'other' }),
        [reviewerSlot, { approval_id: 'c'.repeat(64), contract: null }],
      ),
    ).toThrow(/preflight refused this start.*channel_id/s);
  });
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const PROCESSING_KEY =
  'source:instance:item:revision:processor:instance:version';
const STAGED_APPROVAL_ID = decisionApprovalId(PROCESSING_KEY);

function stagedRequest(): ApprovalRequest {
  const brief = {
    schema_version: 1,
    id: 'brief-1',
    meeting: { id: 'meeting-1', title: 'Planning', participants: [] },
    decisions: [],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-08-11T10:30:00.000Z',
    },
  };
  return {
    processing_key: PROCESSING_KEY,
    requested_at: '2026-08-11T11:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Planning',
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'source',
          instance_id: 'instance',
          version: '1',
        },
        external_id: 'item',
        canonical_revision: 'revision',
        observed_at: '2026-08-11T10:15:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-08-11T10:15:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'meeting-1',
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-08-11T10:30:00.000Z',
      signals: [],
    },
    brief,
  } as unknown as ApprovalRequest;
}

function surfaceConfig(settings: Record<string, unknown> = {}): AdapterConfig {
  return {
    kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    instance_id: 'default',
    credential_ref: 'env:SLACK_BOT_TOKEN',
    settings: {
      channel_id: 'C012CHANNEL',
      reviewer: { slack_user_id: 'U012REVIEWER', name: 'Reviewer One' },
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
      presentation_mode: 'restricted-reviewer-v1',
      ...settings,
    },
  } as unknown as AdapterConfig;
}

async function seededStateDirectory(
  frozen?: Partial<SlackApprovalPresentationContract>,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-startup-'));
  roots.push(root);
  const store = new DecisionNodeStore(root);
  await store.ensureRequested(stagedRequest());
  if (frozen !== undefined) {
    await store.freezeApprovalPresentationContract({
      approvalId: STAGED_APPROVAL_ID,
      contract: {
        ...contract({
          credential_ref: 'env:SLACK_BOT_TOKEN',
          credential_fingerprint_sha256:
            reviewerApprovalPresentationRenderer.credentialFingerprint(
              'xoxb-test',
            ),
        }),
        ...frozen,
      },
    });
  }
  return root;
}

async function seededOrganizationMemberStateDirectory(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'member-startup-'));
  roots.push(root);
  const store = new DecisionNodeStore(root);
  await store.ensureRequested(stagedRequest());
  await store.freezeApprovalPresentationContract({
    approvalId: STAGED_APPROVAL_ID,
    contract: organizationMemberContract(),
  });
  await store.recordPublished({
    processingKey: PROCESSING_KEY,
    surface: 'slack-authority-v1',
    reference: { channel_id: 'C012CHANNEL', message_ts: '171.1' },
  });
  return root;
}

function startSurface(
  stateDirectory: string,
  config: AdapterConfig,
  environment: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-test' },
): unknown {
  const factory = createDefaultAdapterFactories().get(
    'approval-surface',
    'slack-reactions',
  );
  if (factory === undefined) throw new Error('missing factory');
  return factory.create(config, {
    stateDirectory,
    environment,
    credentialResolver: (reference: string) =>
      reference.startsWith('env:')
        ? environment[reference.slice('env:'.length)]
        : undefined,
    now: () => '2026-08-11T13:00:00.000Z',
    reviewerPresentationRenderer: reviewerApprovalPresentationRenderer as never,
  });
}

describe('reviewer publication preflight at startup', () => {
  it('resumes a requested-only crash window under reviewer mode', async () => {
    const root = await seededStateDirectory();
    expect(() => startSurface(root, surfaceConfig())).not.toThrow();
  });

  it('refuses an Authority-published card whose frozen contract is missing', async () => {
    const root = await seededStateDirectory();
    const store = new DecisionNodeStore(root);
    await store.recordPublished({
      processingKey: PROCESSING_KEY,
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C012CHANNEL', message_ts: '171.1' },
    });
    expect(() => startSurface(root, surfaceConfig())).toThrow(
      /published without a frozen approval presentation contract/,
    );
  });

  it.each([
    undefined,
    'restricted-reviewer-v1',
    'organization-member-readable-v1',
  ] as const)(
    'refuses an identified Authority post with no frozen contract under %s',
    async (presentationMode) => {
      const root = await seededStateDirectory();
      const store = new DecisionNodeStore(root);
      await store.recordPublished({
        processingKey: PROCESSING_KEY,
        surface: 'slack-authority-v1-posted',
        reference: { channel_id: 'C012CHANNEL', message_ts: '171.000001' },
      });
      expect(() =>
        startSurface(
          root,
          surfaceConfig({ presentation_mode: presentationMode }),
        ),
      ).toThrow(/identified Authority post without its frozen presentation contract/);
    },
  );

  it('constructs the surface when every unresolved card is a matching reviewer card', async () => {
    const root = await seededStateDirectory({});
    expect(() => startSurface(root, surfaceConfig())).not.toThrow();
  });

  it('refuses to construct the surface after an in-place rotation', async () => {
    const root = await seededStateDirectory({});
    expect(() =>
      startSurface(root, surfaceConfig({ channel_id: 'C099OTHER' })),
    ).toThrow(/froze channel_id/);
    expect(() =>
      startSurface(root, surfaceConfig(), { SLACK_BOT_TOKEN: 'xoxb-rotated' }),
    ).toThrow(/froze its credential value/);
  });

  it('leaves an ordinary start with no reviewer slots untouched', async () => {
    const root = await seededStateDirectory();
    expect(() =>
      startSurface(
        root,
        surfaceConfig({ presentation_mode: undefined }) as AdapterConfig,
      ),
    ).not.toThrow();
  });

  it('refuses every restart mode change over a published schema-v3 card before it can poll or resolve', async () => {
    const root = await seededOrganizationMemberStateDirectory();
    for (const presentation_mode of [
      undefined,
      'pilot-member-readable-v1',
      'restricted-reviewer-v1',
    ]) {
      expect(() =>
        startSurface(
          root,
          surfaceConfig({ presentation_mode }) as AdapterConfig,
        ),
      ).toThrow(/organization-member-readable-v1 presentation contract/);
    }
  });

  /**
   * Every production composition wires a post-resolve hook. The store wrapper
   * that carries it must keep the optional reviewer members, or reviewer mode
   * is silently dead exactly where it is meant to run.
   */
  it('keeps reviewer mode usable through the post-resolve hook wrapper', async () => {
    const root = await seededStateDirectory({});
    const factory = createDefaultAdapterFactories().get(
      'approval-surface',
      'slack-reactions',
    );
    if (factory === undefined) throw new Error('missing factory');
    const environment: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-test' };
    const config = surfaceConfig();
    const surface = factory.create(config, {
      stateDirectory: root,
      environment,
      credentialResolver: (reference: string) =>
        reference.startsWith('env:')
          ? environment[reference.slice('env:'.length)]
          : undefined,
      now: () => '2026-08-11T13:00:00.000Z',
      reviewerPresentationRenderer:
        reviewerApprovalPresentationRenderer as never,
      reviewerApprovalActionAuthorizer: {
        authorizeReviewerApproval: () => {
          throw new Error('unexpected reviewer authorization');
        },
      } as never,
      approvalActionAuthorizer: {
        authorize: () => {
          throw new Error('unexpected authorization');
        },
      } as never,
      afterDecisionResolved: () => undefined,
    }) as unknown as {
      validateConfig(value: AdapterConfig): { ok: boolean; errors: string[] };
    };

    const verdict = surface.validateConfig(config);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
