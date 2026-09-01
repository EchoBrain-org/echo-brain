import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  createPersonPolicyFactProjectorV2,
  createRecordPolicyFactProjectorRegistryV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthorityDatabase } from "../../../../src/adapters/persistence/sqlite/open-authority-database.js";
import { personLoginGrantExpectedEmailSha256 } from "../../../../src/domain/person-email-binding.js";
import type { PersonSessionOidcAuthorizationProvider } from "../../../../src/composition/lazy-person-session-oidc-provider.js";
import type { AnswerCompositionGenerationBundleV1 } from "../../../../src/composition/answer-composition-generation-bundle-v1.js";
import type { ApprovalWorkflowBundleV1 } from "../../../../src/composition/approval-workflow-bundle-v1.js";
import type { DecisionProcessorBundleV1 } from "../../../../src/composition/decision-processor-bundle-v1.js";
import type { MeetingSourceBundleV1 } from "../../../../src/composition/meeting-source-bundle-v1.js";
import { initializePersonSessionCredentials } from "../../../../src/composition/person-onboarding-service.js";
import { bootstrapOrganizationAuthorityState } from "../../../../src/composition/organization-authority-state-bootstrap.js";
import { openOrganizationAuthorityRuntime } from "../../../../src/composition/organization-authority-runtime.js";
import { createSyntheticDemoMeetingSourceBundleV1 } from "../../../../src/composition/providers/synthetic-demo/synthetic-demo-meeting-source-bundle-v1.js";
import {
  SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
  loadSyntheticDemoMeetingCorpusV1,
  syntheticDemoMeetingSourceIdentityV1,
} from "../../../../src/processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";
import type { DecisionProcessorAdapter } from "../../../../src/processing/core/index.js";

const roots: string[] = [];
const NOW = "2026-08-30T00:00:00.000Z";
const ownerEmail = "owner@example.test";
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "demo-client",
  redirect_uri: "https://authority.example/v2/session/oidc/callback",
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};
const processorIdentity = {
  kind: "decision-processor" as const,
  adapter_id: "synthetic-demo-test-processor",
  instance_id: "synthetic-demo-test-processor",
  version: "1.0.0",
};
const processorConfigurationSha256 = canonicalSha256({
  kind: "synthetic-demo-test-processor-config",
});
const processorCredentialReferenceSha256 = canonicalSha256({
  kind: "synthetic-demo-test-processor-credential",
});
const meetingsDirectory = new URL(
  "../../../../../../demo/meetings/",
  import.meta.url,
);

afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function root(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "echo-synthetic-demo-runtime-")),
  );
  chmodSync(directory, 0o700);
  roots.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("test port did not resolve");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

const oidcProvider: PersonSessionOidcAuthorizationProvider = {
  buildAuthorizationUrl: () => "https://issuer.example/authorize",
  async redeemAuthorizationCode() {
    return { kind: "retryable_before_redemption" };
  },
};

function processorBundle(): DecisionProcessorBundleV1 {
  const processor: DecisionProcessorAdapter = {
    identity: processorIdentity,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({ status: "healthy", checked_at: NOW }),
    async extract(meeting) {
      return {
        schema_version: 1,
        meeting_id: meeting.id,
        meeting_revision: meeting.provenance.canonical_revision,
        processor: processorIdentity,
        generated_at: NOW,
        signals: [],
      };
    },
  };
  return {
    processor_adapter_id: processorIdentity.adapter_id,
    assert_admission_commitments(commitments) {
      expect(commitments.processor).toMatchObject({
        adapter_id: processorIdentity.adapter_id,
        instance_id: processorIdentity.instance_id,
        version: processorIdentity.version,
        configuration_sha256: processorConfigurationSha256,
        credential_reference_sha256: processorCredentialReferenceSha256,
      });
    },
    create_processor: () => processor,
  };
}

const approvalBundle: ApprovalWorkflowBundleV1 = {
  async assert_existing_presentations_owned() {},
  async load() {
    return {
      stager: {
        async stage() {
          return { kind: "staged", stage_id: "synthetic-demo-test-stage" };
        },
        async reconcilePendingDeliveries() {},
        async reconcileSuperseded() {},
      },
      processing: {
        async recoverV4Appends() {},
        async observeAndFinalizePendingApprovals() {},
        async appendFinalizedApprovalsToV4() {},
      },
    };
  },
};

const answerBundle: AnswerCompositionGenerationBundleV1 = {
  load() {
    return {
      generation: {
        generation_adapter_id: "synthetic-demo-test-generation",
        planner_model: "test-planner",
        answer_model: "test-answer",
        timeout_ms: 1_000,
      },
      structured_output: {
        async generate() {
          throw new Error("answer generation was not expected");
        },
      },
    };
  },
};

function insertMatchingAdmission(input: {
  readonly state_directory: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly corpus_digest: string;
}): void {
  const authority = openAuthorityDatabase(
    join(input.state_directory, "authority.sqlite"),
    {
      fileMustExist: true,
    },
  );
  try {
    authority
      .prepare(
        `INSERT INTO authority_live_source_admission_v2 (
          singleton, organization_id, principal_id, membership_id, membership_type,
          source_adapter_id, source_adapter_version, source_adapter_instance_id,
          normalizer_version, source_custodian_sha256,
          source_custodian_assurance, source_custodian_observed_at,
          source_credential_reference_sha256, initial_cursor, cutoff_at,
          processor_adapter_id, processor_adapter_version, processor_instance_id,
          processor_configuration_sha256, processor_credential_reference_sha256,
          semantic_input_sha256, admitted_at
        ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        input.organization_id,
        input.principal_id,
        input.membership_id,
        syntheticDemoMeetingSourceIdentityV1.adapter_id,
        syntheticDemoMeetingSourceIdentityV1.version,
        syntheticDemoMeetingSourceIdentityV1.instance_id,
        syntheticDemoMeetingSourceIdentityV1.version,
        personLoginGrantExpectedEmailSha256(ownerEmail),
        "authority_initial_owner_identity",
        NOW,
        input.corpus_digest,
        SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
        NOW,
        processorIdentity.adapter_id,
        processorIdentity.version,
        processorIdentity.instance_id,
        processorConfigurationSha256,
        processorCredentialReferenceSha256,
        canonicalSha256({ kind: "synthetic-demo-runtime-test-admission" }),
        NOW,
      );
  } finally {
    authority.close();
  }
}

describe("synthetic-demo organization-authority runtime", () => {
  it("stays idle before admission and constructs the real source after matching admission", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Synthetic Demo Organization",
      owner_display_name: "Demo Owner",
      created_at: NOW,
      creating_artifact_revision: "synthetic-demo-runtime-test",
    });
    const credentials = initializePersonSessionCredentials({
      state_directory: initialized.state_directory,
    });
    const concreteBundle = await createSyntheticDemoMeetingSourceBundleV1({
      meetings_directory: new URL(meetingsDirectory).pathname,
      owner_email: ownerEmail,
    });
    let sourceFactoryCalls = 0;
    const sourceBundle: MeetingSourceBundleV1 = {
      ...concreteBundle,
      create_source(admission) {
        sourceFactoryCalls += 1;
        return concreteBundle.create_source(admission);
      },
    };
    const config = {
      state_directory: initialized.state_directory,
      host: "127.0.0.1" as const,
      port: await availablePort(),
      authority_url: "https://authority.example",
      oidc: OIDC,
      client_authentication: { method: "none" as const },
      pkce_key_file: credentials.pkce_sealing_key_reference.slice(
        "file:".length,
      ),
      meeting_source_bundle: sourceBundle,
      decision_processor_bundle: processorBundle(),
      approval_workflow_bundle: approvalBundle,
      answer_composition_generation_bundle: answerBundle,
      record_policy_fact_projectors: createRecordPolicyFactProjectorRegistryV1([
        createPersonPolicyFactProjectorV2(),
      ]),
      worker_interval_ms: 60_000,
    };

    const idle = await openOrganizationAuthorityRuntime(config, {
      api: { oidc_provider: oidcProvider },
    });
    try {
      expect(idle.processing).toBe("idle_until_finalize");
      expect(sourceFactoryCalls).toBe(0);
    } finally {
      await idle.close();
    }

    const corpus = await loadSyntheticDemoMeetingCorpusV1(
      new URL(meetingsDirectory).pathname,
    );
    insertMatchingAdmission({
      state_directory: initialized.state_directory,
      organization_id: initialized.organization_id,
      principal_id: initialized.owner_principal_id,
      membership_id: initialized.owner_membership_id,
      corpus_digest: corpus.corpus_digest,
    });
    const active = await openOrganizationAuthorityRuntime(config, {
      api: { oidc_provider: oidcProvider },
    });
    try {
      expect(active.processing).toBe("active");
      expect(sourceFactoryCalls).toBe(1);
    } finally {
      await active.close();
    }
  });
});
