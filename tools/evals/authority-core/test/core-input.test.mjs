import assert from "node:assert/strict";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAuthorityDatabase } from "../../../../packages/organization-authority-kernel/dist/adapters/persistence/sqlite/open-authority-database.js";
import { bootstrapOrganizationAuthorityState } from "../../../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";
import { createCoreIdentity } from "../core-identity.mjs";
import { coreInputIdentities, createCoreInput } from "../core-input.mjs";

test("statically admits the authenticated owner and replays immutable offered evidence at its durable cursor", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "echo-capacity-core-input-"));
  chmodSync(directory, 0o700);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(directory, "state"), organization_display_name: "Core Input Test",
    owner_display_name: "Core Owner", created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "capacity-core-input-test",
  });
  let identity;
  let authority;
  try {
    identity = await createCoreIdentity({
      state_directory: initialized.state_directory, owner_membership_id: initialized.owner_membership_id,
      pkce_sealing_key: randomBytes(32),
    });
    authority = openAuthorityDatabase(join(initialized.state_directory, "authority.sqlite"), { fileMustExist: true });
    const input = createCoreInput({
      authority, coordinates: { organization_id: initialized.organization_id }, owner: identity.owner, sessions: identity.sessions,
    });
    assert.equal(authority.prepare("SELECT count(*) FROM authority_live_source_admission_v2").pluck().get(), 1);
    const text = "Core input preserves the source cursor on retry.";
    const meeting = {
      schema_version: 1, id: "core-input:meeting-1", title: "Core input meeting",
      provenance: {
        source: coreInputIdentities.source, external_id: "meeting-1", canonical_revision: canonicalSha256({ text }),
        observed_at: "2026-09-06T00:00:00.000Z", normalizer_version: coreInputIdentities.source.version,
      },
      capture: { state: "complete", components: [] }, participants: [],
      content: [{ id: "block-1", kind: "note", text }], artifacts: [],
    };
    const decisions = {
      schema_version: 1, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision,
      processor: coreInputIdentities.processor, generated_at: "2026-09-06T00:00:00.000Z",
      signals: [{ id: "decision-1", kind: "decision", status: "decided", text, subject: null, confidence: 1, evidence: [{ meeting_id: meeting.id, block_id: "block-1" }] }],
    };
    input.offer({ meeting, decisions });
    const first = await input.source.pull({ cursor: "core-input:v1:0", limit: 1 });
    const retry = await input.source.pull({ cursor: "core-input:v1:0", limit: 1 });
    assert.deepEqual(retry, first);
    assert.equal(first.next_cursor, "core-input:v1:1");
    assert.equal((await input.processor.extract(first.meetings[0])).signals[0].id, "decision-1");

    await t.test("accepts an equivalent snapshot without sharing object identity", async () => {
      const snapshot = structuredClone(first.meetings[0]);
      assert.notEqual(snapshot, first.meetings[0]);
      assert.deepEqual(await input.processor.extract(snapshot), decisions);
    });

    await t.test("rejects changed content or provenance under the same offered identity and revision", async () => {
      const changedContent = structuredClone(first.meetings[0]);
      changedContent.content[0].text = "Evidence that was never offered.";
      await assert.rejects(input.processor.extract(changedContent), /unoffered meeting revision/);
      const changedProvenance = structuredClone(first.meetings[0]);
      changedProvenance.provenance.external_id = "different-provider-item";
      await assert.rejects(input.processor.extract(changedProvenance), /unoffered meeting revision/);
    });

    await t.test("pins meeting and decisions against caller mutations after offer", async () => {
      meeting.content[0].text = "Caller changed the source after offer.";
      decisions.signals[0].text = "Caller changed the result after offer.";
      const replay = await input.source.pull({ cursor: "core-input:v1:0", limit: 1 });
      assert.equal(replay.meetings[0].content[0].text, text);
      const result = await input.processor.extract(structuredClone(replay.meetings[0]));
      assert.equal(result.signals[0].text, text);
      assert.throws(() => { result.signals[0].text = "Mutation through returned result."; }, TypeError);
    });
  } finally {
    authority?.close();
    identity?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
