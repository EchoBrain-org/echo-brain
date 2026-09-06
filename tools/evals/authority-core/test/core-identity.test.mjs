import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapOrganizationAuthorityState } from "../../../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";
import { createCoreIdentity } from "../core-identity.mjs";

test("creates owner and employee sessions through the real Authority application and database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-capacity-core-identity-"));
  chmodSync(directory, 0o700);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(directory, "state"),
    organization_display_name: "Core Identity Test",
    owner_display_name: "Core Owner",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "capacity-core-identity-test",
  });
  let identity;
  try {
    identity = await createCoreIdentity({
      state_directory: initialized.state_directory,
      owner_membership_id: initialized.owner_membership_id,
      pkce_sealing_key: randomBytes(32),
    });
    const owner = identity.sessions.authenticateAccess({ access_token: identity.owner.access_token });
    const employee = identity.sessions.authenticateAccess({ access_token: identity.employee.access_token });
    assert.equal(owner.membership_type, "owner");
    assert.equal(owner.membership_id, initialized.owner_membership_id);
    assert.equal(employee.membership_type, "employee");
    assert.notEqual(employee.membership_id, owner.membership_id);
  } finally {
    identity?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
