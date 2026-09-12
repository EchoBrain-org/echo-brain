import { describe, expect, it } from "vitest";
import { composeRecordApproverProjectorsV1, type RecordApproverProjectorV1 } from "../src/organization-record-api-v1.js";

const actor = { authority_id: "authority", organization_id: "organization", state_lineage_id: "lineage", approval_id: "approval", principal_id: "principal", membership_id: "membership" };
const historical: RecordApproverProjectorV1 = envelope => envelope.protocol === "historical" ? actor : undefined;
const current: RecordApproverProjectorV1 = envelope => envelope.protocol === "current" ? { ...actor, principal_id: "current" } : undefined;

describe("retained record approver projectors", () => {
  it("retains historical and current protocols independently of selection order", () => {
    for (const selection of [[historical, current], [current, historical]]) {
      const project = composeRecordApproverProjectorsV1(selection);
      expect(project({ protocol: "historical" })).toEqual(actor);
      expect(project({ protocol: "current" })).toEqual({ ...actor, principal_id: "current" });
      expect(project({ protocol: "unknown" })).toBeUndefined();
    }
  });
  it("omits ambiguous metadata even when two projectors return the same actor", () => {
    expect(composeRecordApproverProjectorsV1([historical, () => actor])({ protocol: "historical" })).toBeUndefined();
    expect(composeRecordApproverProjectorsV1([])({})).toBeUndefined();
  });
  it("snapshots the selection and treats repeated references as one projector", () => {
    const selection = [historical, historical];
    const project = composeRecordApproverProjectorsV1(selection);
    selection.push(() => actor);
    expect(project({ protocol: "historical" })).toEqual(actor);
  });
});
