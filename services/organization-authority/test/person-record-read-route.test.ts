import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import { createPersonRecordReadRouteV1, type CreatePersonRecordReadRouteV1Options } from "../src/composition/person-record-read-route.js";
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import type { PersonRecordReadHttpApplicationV1 } from "../src/presentation/person-record-read-http-application.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });

function authorization(
  values: Partial<PersonAccessAuthorization> = {},
): PersonAccessAuthorization {
  return {
    organization_id: "org_clean",
    principal_id: "principal_founder",
    membership_id: "membership_founder",
    membership_type: "owner",
    identity_binding_id: "identity_founder",
    session_family_id: "session_founder",
    access_credential_sha256: digest("access"),
    access_expires_at: "2026-08-22T01:00:00.000Z",
    hard_reauthentication_at: "2026-08-22T02:00:00.000Z",
    person_state_sha256: digest("person"),
    session_state_sha256: digest("session"),
    checked_at: "2026-08-22T00:00:00.000Z",
    ...values,
  };
}

function setup(
  authorizations: readonly PersonAccessAuthorization[] = [
    authorization(),
    authorization(),
  ],
  overrides: Partial<CreatePersonRecordReadRouteV1Options> = {},
) {
  const authority = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(authority);
  let authenticateCalls = 0;
  const inputs: unknown[] = [];
  const route = createPersonRecordReadRouteV1({
    authority_id: "authority_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    sessions: {
      authenticateAccess: () => {
        const value = authorizations[authenticateCalls];
        authenticateCalls += 1;
        if (value === undefined) throw new Error("unexpected authentication");
        return value;
      },
    },
    records: {
      list: (input) => {
        inputs.push(input);
        return Object.freeze([
          Object.freeze({
            position: 7,
            approval_id: "approval_7",
            record_sha256: digest("record-7"),
            envelope: Object.freeze({ record: "approved" }),
          }),
        ]);
      },
    },
    audit: new SqlitePersonRecordReadAuditV1(authority),
    ...overrides,
  });
  return {
    authority,
    route,
    inputs,
    authenticateCalls: () => authenticateCalls,
  };
}

describe("Person V4 record read route", () => {
  const approver = {
    organization_id: "org_clean", principal_id: "principal_approver",
    membership_id: "membership_approver", display_name: "Maya Chen",
  };
  const projectedApprover = () => ({
    authority_id: "authority_clean", organization_id: "org_clean", state_lineage_id: "lineage_clean",
    approval_id: "approval_7", principal_id: approver.principal_id, membership_id: approver.membership_id,
  });
  function metadataRecord() {
    return {
      position: 7, approval_id: "approval_7", record_sha256: digest("record-7"),
      envelope: { signed_actor: "fixture-actor-reference" },
    };
  }

  it("optionally resolves the exact record approver without changing the signed envelope or legacy response", () => {
    const membership = vi.fn(() => approver);
    const record = metadataRecord();
    const project = vi.fn(projectedApprover);
    const value = setup([authorization(), authorization(), authorization(), authorization()], {
      records: { list: () => [record] }, record_approver: project, memberships: { membership },
    });
    try {
      const legacy = value.route.list({ access_token: "bearer-only" });
      expect(legacy.records[0]).not.toHaveProperty("source_metadata");
      expect(membership).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
      const enriched = value.route.list({ access_token: "bearer-only", include_source_metadata: true });
      expect(membership).toHaveBeenCalledExactlyOnceWith("membership_approver");
      expect(enriched.records[0]?.source_metadata).toEqual({ record_approved_by: { display_name: "Maya Chen" } });
      expect(enriched.records[0]?.envelope).toBe(record.envelope);
      expect(JSON.stringify(enriched.records[0]?.source_metadata)).not.toContain("principal_");
    } finally { value.authority.close(); }
  });

  it("does not infer an approver from an unknown resolution with familiar fields", () => {
    const record = metadataRecord();
    const unknown = { ...record, envelope: { body: {
      authority_id: "authority_clean", organization_id: "org_clean", state_lineage_id: "lineage_clean",
      event: { kind: "approved" }, human_act_resolution_ref: {
        kind: "unknown-resolution-v1", action: "approve", organization_id: "org_clean", approval_id: "approval_7",
        final_approver: { principal_id: approver.principal_id, membership_id: approver.membership_id },
      },
    } } };
    const membership = vi.fn(() => approver);
    const value = setup(undefined, { records: { list: () => [unknown] }, memberships: { membership } });
    try {
      expect(value.route.list({ access_token: "bearer-only", include_source_metadata: true }).records[0]?.source_metadata).toEqual({});
      expect(membership).not.toHaveBeenCalled();
    } finally { value.authority.close(); }
  });

  it("uses the injected projection for a record with a different actor shape", () => {
    const record = { ...metadataRecord(), envelope: { signed_actor: "another-format" } };
    const record_approver = vi.fn(() => ({
      authority_id: "authority_clean", organization_id: "org_clean", state_lineage_id: "lineage_clean",
      approval_id: "approval_7", principal_id: approver.principal_id, membership_id: approver.membership_id,
    }));
    const value = setup(undefined, {
      records: { list: () => [record] }, record_approver, memberships: { membership: () => approver },
    });
    try {
      const response = value.route.list({ access_token: "bearer-only", include_source_metadata: true });
      expect(response.records[0]?.source_metadata).toEqual({ record_approved_by: { display_name: "Maya Chen" } });
      expect(record_approver).toHaveBeenCalledExactlyOnceWith(record.envelope);
      expect(response.records[0]?.envelope).toBe(record.envelope);
    } finally { value.authority.close(); }
  });

  it.each([
    "authority_id", "organization_id", "state_lineage_id", "approval_id",
  ] as const)("rejects a projected approver with mismatched %s before looking up a name", (coordinate) => {
    const membership = vi.fn(() => approver);
    const value = setup(undefined, {
      records: { list: () => [metadataRecord()] },
      record_approver: () => ({ ...projectedApprover(), [coordinate]: "another-record" }),
      memberships: { membership },
    });
    try {
      expect(value.route.list({ access_token: "bearer-only", include_source_metadata: true }).records[0]?.source_metadata).toEqual({});
      expect(membership).not.toHaveBeenCalled();
    } finally { value.authority.close(); }
  });

  it.each([
    undefined,
    { ...approver, organization_id: "another_org" },
    { ...approver, principal_id: "another_person" },
    { ...approver, membership_id: "another_tenure" },
    { ...approver, display_name: "" },
    { ...approver, display_name: "spoof\u202ename" },
  ])("omits unavailable or mismatched approver metadata: %j", (resolved) => {
    const value = setup(undefined, { records: { list: () => [metadataRecord()] }, record_approver: projectedApprover, memberships: { membership: () => resolved } });
    try {
      expect(value.route.list({ access_token: "bearer-only", include_source_metadata: true }).records[0]?.source_metadata).toEqual({});
    } finally { value.authority.close(); }
  });

  it("does not look up names for inaccessible records and withholds metadata when caller membership changes", () => {
    const membership = vi.fn(() => approver);
    const project = vi.fn(projectedApprover);
    const empty = setup(undefined, { records: { list: () => [] }, record_approver: project, memberships: { membership } });
    try {
      expect(empty.route.list({ access_token: "bearer-only", include_source_metadata: true }).records).toEqual([]);
      expect(project).not.toHaveBeenCalled();
      expect(membership).not.toHaveBeenCalled();
    } finally { empty.authority.close(); }
    const changed = setup([authorization(), authorization({ membership_id: "changed" })], {
      records: { list: () => [metadataRecord()] }, record_approver: projectedApprover, memberships: { membership },
    });
    try {
      expect(() => changed.route.list({ access_token: "bearer-only", include_source_metadata: true })).toThrow("person authentication failed");
      expect(changed.authority.prepare("SELECT count(*) AS count FROM authority_person_read_decision_audit_v2").get()).toEqual({ count: 0 });
    } finally { changed.authority.close(); }
  });

  it("derives the V4 reader tuple from the bearer, rechecks it at release, and commits one minimized audit", () => {
    const value = setup();
    try {
      const response = value.route.list({
        access_token: "bearer-only",
        limit: 3,
      });

      expect(value.authenticateCalls()).toBe(2);
      expect(value.inputs).toEqual([
        {
          authority_id: "authority_clean",
          organization_id: "org_clean",
          state_lineage_id: "lineage_clean",
          principal_id: "principal_founder",
          membership_id: "membership_founder",
          limit: 3,
        },
      ]);
      expect(response).toEqual({
        schema_version: 1,
        kind: "echo-clean-person-record-list-v1",
        records: [
          {
            position: 7,
            approval_id: "approval_7",
            record_sha256: digest("record-7"),
            envelope: { record: "approved" },
          },
        ],
      });
      expect(Object.isFrozen(response)).toBe(true);
      expect(Object.isFrozen(response.records)).toBe(true);

      const audit = value.authority
        .prepare(
          `SELECT body_json, context_kind, prompt_sha256, answer_sha256, recorded_at
             FROM authority_person_read_decision_audit_v2`,
        )
        .get() as {
        body_json: string;
        context_kind: string;
        prompt_sha256: string | null;
        answer_sha256: string | null;
        recorded_at: string;
      };
      expect(JSON.parse(audit.body_json)).toMatchObject({
        kind: "echo-clean-person-record-read-audit-v1",
        read_mode: "layer1",
        authority_id: "authority_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        principal_id: "principal_founder",
        membership_id: "membership_founder",
        result_count: 1,
      });
      expect(audit.recorded_at).toBe("2026-08-22T00:00:00.000Z");
      expect(audit.context_kind).toBe("record_read");
      expect(audit.prompt_sha256).toBeNull();
      expect(audit.answer_sha256).toBeNull();
    } finally {
      value.authority.close();
    }
  });

  it("does not release an exact record after membership changes and preserves prior audit evidence", () => {
    const value = setup([
      authorization(),
      authorization(),
      authorization(),
      authorization({ membership_id: "membership_revoked" }),
    ]);
    try {
      const record_sha256 = digest("old-cited-record");
      expect(value.route.list({ access_token: "bearer-only", record_sha256 })).toMatchObject({
        records: [{ record_sha256: digest("record-7") }],
      });
      expect(() => value.route.list({ access_token: "bearer-only", record_sha256 })).toThrow(
        "person authentication failed",
      );
      expect(
        value.authority
          .prepare(
            `SELECT count(*) AS count FROM authority_person_read_decision_audit_v2`,
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      value.authority.close();
    }
  });

  it("forwards an exact digest through the same rechecked and audited read", () => {
    const value = setup();
    try {
      const record_sha256 = digest("old-cited-record");
      const response = value.route.list({
        access_token: "bearer-only",
        record_sha256,
      });
      expect(value.inputs).toEqual([
        expect.objectContaining({ record_sha256 }),
      ]);
      expect(response.kind).toBe("echo-clean-person-record-list-v1");
      expect(value.authenticateCalls()).toBe(2);
      expect(
        value.authority
          .prepare("SELECT count(*) AS count FROM authority_person_read_decision_audit_v2")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      value.authority.close();
    }
  });
});

async function startRecordServer(application: PersonRecordReadHttpApplicationV1) {
  const server = createOrganizationAuthorityHttpServer({
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: "https://issuer.example",
    person_record_read: application,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() { const closed = once(server, "close"); server.close(); await closed; },
  };
}

describe("Person exact record HTTP query", () => {
  it("accepts one exact digest and rejects duplicate or combined query keys", async () => {
    const record_sha256 = digest("old-cited-record");
    const list = vi.fn(() => Object.freeze({
      schema_version: 1 as const,
      kind: "echo-clean-person-record-list-v1" as const,
      records: Object.freeze([]),
    }));
    const server = await startRecordServer({ list });
    try {
      const headers = { authorization: "Bearer bearer-only" };
      const exact = await fetch(`${server.url}/v1/person/records?record_sha256=${record_sha256}`, { headers });
      expect(exact.status).toBe(200);
      expect(list).toHaveBeenCalledWith({ access_token: "bearer-only", record_sha256 });
      for (const query of [
        `record_sha256=${record_sha256}&limit=1`,
        `record_sha256=${record_sha256}&record_sha256=${record_sha256}`,
      ]) {
        const response = await fetch(`${server.url}/v1/person/records?${query}`, { headers });
        expect(response.status).toBe(400);
      }
      expect(list).toHaveBeenCalledTimes(1);
      const enriched = await fetch(`${server.url}/v1/person/records?record_sha256=${record_sha256}`, {
        headers: { ...headers, "x-echo-person-record-version": "2" },
      });
      expect(enriched.status).toBe(200);
      expect(list).toHaveBeenLastCalledWith({ access_token: "bearer-only", record_sha256, include_source_metadata: true });
    } finally {
      await server.close();
    }
  });
});
