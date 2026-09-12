import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1,
  verifyOrganizationAuthorityPin, verifyOrganizationRecordEnvelopeV4, verifyOrganizationRecordReceiptV2,
} from "../src/index.js";

// Generated once with the pre-composition implementation at 0817398. Private
// signing material was ephemeral and is absent from this public signed fixture.
const historical = JSON.parse(readFileSync(new URL("./fixtures/pre-codec-slack-v4.json", import.meta.url), "utf8"));

describe("historical V4 codec retention", () => {
  it("preserves every signed record and receipt byte while active workflow selection changes independently", () => {
    const pinned = verifyOrganizationAuthorityPin(historical.descriptor, historical.pin);
    const retained = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1]);
    const verified = verifyOrganizationRecordEnvelopeV4(historical.envelope, pinned, historical.lineage, retained);
    expect(canonicalJson(verified)).toBe(canonicalJson(historical.envelope));
    const receipt = verifyOrganizationRecordReceiptV2(historical.receipt, historical.envelope, pinned, historical.lineage, retained);
    expect(canonicalJson(receipt)).toBe(canonicalJson(historical.receipt));
    // A deployment that forgets a historical codec must fail closed.
    expect(() => verifyOrganizationRecordEnvelopeV4(historical.envelope, pinned, historical.lineage)).toThrow("unknown");
    expect(() => verifyOrganizationRecordEnvelopeV4({ ...historical.envelope, body: { ...historical.envelope.body,
      human_act_resolution_ref: { ...historical.envelope.body.human_act_resolution_ref, current_slack_identity_link: { provider: "other" } },
    } }, pinned, historical.lineage, retained)).toThrow();
  });
});
