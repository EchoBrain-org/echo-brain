import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaselineV4 } from "../../../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../../../src/adapters/persistence/sqlite/open-authority-database.js";
import {
  OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
  openRouterDecisionProcessorConfigurationSha256V1,
} from "../../../../src/composition/providers/openrouter/openrouter-decision-processor-config-v1.js";
import { verifyPersistedOpenRouterDecisionProcessorAdmissionV1 } from "../../../../src/composition/providers/openrouter/verify-openrouter-decision-processor-admission-v1.js";

const roots: string[] = [];
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-01T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function authorityState(): { readonly root: string; readonly database: string } {
  const root = mkdtempSync(join(tmpdir(), "echo-openrouter-admission-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const database = join(root, "authority.sqlite");
  const authority = openAuthorityDatabase(database);
  try {
    applyAuthorityBaselineV4(authority);
    authority
      .prepare(
        `INSERT INTO authority_metadata (
          singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at
        ) VALUES (1, 'oau_1', 'org_1', 'Example', '{}', ?, ?)`,
      )
      .run(NOW, NOW);
    authority
      .prepare(
        `INSERT INTO authority_principals (
          principal_id, organization_id, display_name, provisioned_at
        ) VALUES ('prn_1', 'org_1', 'Owner', ?)`,
      )
      .run(NOW);
    authority
      .prepare(
        `INSERT INTO authority_memberships (
          membership_id, organization_id, principal_id, membership_type, status,
          provisioned_at, revoked_at, revocation_reason, employee_email,
          employee_email_sha256
        ) VALUES ('mem_1', 'org_1', 'prn_1', 'owner', 'active', ?, NULL, NULL, NULL, NULL)`,
      )
      .run(NOW);
  } finally {
    authority.close();
  }
  return { root, database };
}

function admitProcessor(
  databasePath: string,
  version: string,
  configurationSha256: string,
): void {
  const authority = openAuthorityDatabase(databasePath, { fileMustExist: true });
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
        ) VALUES (
          1, 'org_1', 'prn_1', 'mem_1', 'owner',
          'granola', '1.0.0', 'granola-1', '1.0.0', ?, 'owner_verified', ?, ?,
          'granola:v1:live:zero', ?, 'llm', ?, 'llm-1', ?, ?, ?, ?
        )`,
      )
      .run(
        DIGEST,
        NOW,
        DIGEST,
        NOW,
        version,
        configurationSha256,
        DIGEST,
        DIGEST,
        NOW,
      );
  } finally {
    authority.close();
  }
}

describe("persisted OpenRouter processor admission verifier", () => {
  it("allows fresh state and the current immutable processor commitment", () => {
    const state = authorityState();
    expect(() =>
      verifyPersistedOpenRouterDecisionProcessorAdmissionV1(state.root),
    ).not.toThrow();
    admitProcessor(
      state.database,
      OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
      openRouterDecisionProcessorConfigurationSha256V1(),
    );
    expect(() =>
      verifyPersistedOpenRouterDecisionProcessorAdmissionV1(state.root),
    ).not.toThrow();
  });

  it("rejects a legacy admitted processor without changing persisted state", () => {
    const state = authorityState();
    admitProcessor(
      state.database,
      "1.3.0+processing.legacy",
      `sha256:${"b".repeat(64)}`,
    );
    const before = readFileSync(state.database);
    expect(() =>
      verifyPersistedOpenRouterDecisionProcessorAdmissionV1(state.root),
    ).toThrow(/replace-rehearsal --confirm-no-live-users/);
    expect(readFileSync(state.database)).toEqual(before);
  });
});
