import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson, canonicalSha256, type JsonObject, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  buildHumanActRecordInputV1, createOrganizationRecordEnvelopeV4, createOrganizationRecordReceiptV2,
  organizationAuthorityPinSha256, verifyOrganizationAuthorityPin, verifyOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordReceiptV2, validateOrganizationRecordReceiptBodyV2,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID, RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  restrictedReviewerPersonPolicyContractSha256, restrictedReviewerPersonConsequenceSha256,
} from "@echo-brain/organization-protocol";
import type { V4RecordEnvelopeView, RevalidatedPersonPolicyAuthorizationWitnessV2 } from "@echo-brain/organization-record/organization-record-api-v1";
import type { ApprovalWorkflowBundleV1, ApprovalWorkflowContextV1 } from "../../src/composition/approval-workflow-bundle-v1.js";
import type { ApprovalWorkflowStageInputV1 } from "../../src/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { compileDecisionBrief } from "../../src/processing/core/processing/brief.js";

interface Presentation {
  approval_id: string;
  candidate_id: string;
  snapshot: Readonly<Record<string, unknown>>;
  card_sha256: Sha256Digest;
  phase: "presented" | "queued" | "finalized" | "appended" | "rejected" | "retired";
  action?: "approve" | "reject";
  issued_at: string;
}

/** Offline seam proof: durable adapter state, real Authority state and signed append. */
export function persistedApprovalWorkflowFixtureV1(options: {
  path: string;
  actor: { principal_id: string; membership_id: string };
  /** Simulates a process stopping after the externally visible presentation. */
  stop_after_present?: () => boolean;
  /** Simulates a process stopping after record commit but before receipt signing. */
  stop_before_receipt?: () => boolean;
}) {
  const read = (): Presentation[] => existsSync(options.path) ? JSON.parse(readFileSync(options.path, "utf8")) as Presentation[] : [];
  const save = (rows: Presentation[]) => {
    writeFileSync(`${options.path}.next`, canonicalJson(rows), { mode: 0o600 });
    renameSync(`${options.path}.next`, options.path);
  };
  const update = (row: Presentation) => save([...read().filter((value) => value.approval_id !== row.approval_id), row]);
  const assertOwned = (context: ApprovalWorkflowContextV1) => {
    const owned = read();
    for (const pending of context.state.listOutstandingApprovalPresentations()) {
      if (!owned.some((row) => row.approval_id === pending.approval_id && row.candidate_id === pending.candidate_id)) {
        throw new Error(`fixture cannot prove ownership of outstanding ${pending.state} presentation ${pending.approval_id}`);
      }
    }
  };
  const bundle: ApprovalWorkflowBundleV1 = {
    async assert_existing_presentations_owned(context) { assertOwned(context); },
    async load(context) {
      const descriptor = await context.signer.inspect();
      const pinned = verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor));
      const lineage = context.coordinates.state_lineage_id;
      const sign = context.signer.sign.bind(context.signer);
      async function stage(input: ApprovalWorkflowStageInputV1) {
        let row = read().find((value) => value.approval_id === input.candidate.approval_id);
        if (!row) {
          const payload = {
            brief: compileDecisionBrief(`fixture-brief:${input.candidate.approval_id}`, input.meeting, input.decisions),
            source: { adapter_id: input.meeting.provenance.source.adapter_id, instance_id: input.meeting.provenance.source.instance_id, external_id: input.meeting.provenance.external_id },
            alternatives: [], links: null, reviewed_at: input.decisions.generated_at, surface: "fixture-confirmation",
          };
          const snapshot = { schema_version: 2, kind: "echo-approved-decision-snapshot-v2", approval_id: input.candidate.approval_id,
            staged_content_sha256: canonicalSha256({ meeting: input.meeting, decisions: input.decisions }), final_content_sha256: canonicalSha256(payload),
            payload_contract_id: "organization-record-approval-payload-v1", approved_payload: payload };
          row = { approval_id: input.candidate.approval_id, candidate_id: input.candidate.candidate_id, snapshot,
            card_sha256: canonicalSha256(snapshot), phase: "presented", issued_at: input.decisions.generated_at };
        }
        const prepared = context.state.prepareApprovalPost({ candidate_id: row.candidate_id, frozen_card_sha256: row.card_sha256, approved_snapshot: row.snapshot });
        if (prepared.outbox.state === "superseded") return { kind: "state_drift" as const };
        if (prepared.created) {
          update(row); // The fixture's external system and its durable receipt agree here.
          if (options.stop_after_present?.()) throw new Error("fixture stopped after presentation");
        }
        if (prepared.outbox.state === "posting") context.state.recordPostedApprovalCard({ candidate_id: row.candidate_id,
          post_started_at: prepared.outbox.post_started_at!, presentation_external_id: `fixture:${row.approval_id}`,
          frozen_card_sha256: row.card_sha256, approved_snapshot: row.snapshot });
        context.state.markControlPlaneStaged({ candidate_id: row.candidate_id, control_approval_sha256: canonicalSha256({ approval_id: row.approval_id, card_sha256: row.card_sha256 }) });
        return { kind: "staged" as const, stage_id: `fixture:${row.approval_id}` };
      }
      async function append(row: Presentation) {
        const frozen = context.state.readFrozenCandidateForApproval(row.approval_id);
        if (!frozen || frozen.candidate_id !== row.candidate_id || frozen.approved_snapshot_sha256 !== canonicalSha256(row.snapshot)) throw new Error("fixture frozen candidate drift");
        const policy_id = RESTRICTED_REVIEWER_PERSON_POLICY_ID;
        const policy_contract_sha256 = restrictedReviewerPersonPolicyContractSha256();
        const provider_action_sha256 = canonicalSha256({ row, actor: options.actor });
        const authorization_proof_sha256 = canonicalSha256({ ...context.coordinates, approval_id: row.approval_id, actor: options.actor });
        const audit_entry = { ...context.coordinates, audit_event_id: `fixture-audit:${row.approval_id}`, audit_sequence: 1,
          actor_class: "provider_human" as const, ...options.actor, action: "approve" as const,
          subject_kind: "approval" as const, subject_id: row.approval_id, detail_digest: authorization_proof_sha256, provider_action_sha256 };
        const human = buildHumanActRecordInputV1({
          human_act_resolution_ref: { schema_version: 1, kind: "echo-human-act-resolution-ref-v1", ...context.coordinates,
            approval_id: row.approval_id, action: "approve", policy_id, policy_contract_sha256,
            audit_event_id: audit_entry.audit_event_id, audit_sequence: 1, audit_entry_sha256: canonicalSha256(audit_entry),
            provider_action_kind: "echo-provider-human-action-v2", provider_action_schema_version: 2,
            provider_action_sha256, authorization_proof_sha256 },
          event: { kind: "approved", approved_snapshot: row.snapshot as never, approved_snapshot_sha256: canonicalSha256(row.snapshot),
            policy_id, policy_contract_sha256, policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
            policy_consequence_sha256: restrictedReviewerPersonConsequenceSha256() },
        });
        const authorization_witness: RevalidatedPersonPolicyAuthorizationWitnessV2 = {
          authorization_allow: { ...context.coordinates, approval_id: row.approval_id, action: "approve", policy_id,
            policy_contract_sha256, ...options.actor, provider_action_sha256, decision: "allow" },
          authorization_proof_sha256, provider_action_kind: "echo-provider-human-action-v2", provider_action_schema_version: 2,
          audit_entry, audit_entry_sha256: canonicalSha256(audit_entry),
        };
        const source = frozen.meeting.provenance;
        const result = await context.record_append.append({ approval_id: row.approval_id, action: "approve",
          semantic_idempotency_key: human.semantic_idempotency_key, receipt_issued_at: row.issued_at, authorization_witness,
          envelope_factory: {
            create: async (allocation) => await createOrganizationRecordEnvelopeV4({
              envelope_id: `fixture-envelope:${row.approval_id}`, issued_at: row.issued_at,
              predecessor_position: allocation.predecessor_position, predecessor_record_sha256: allocation.predecessor_record_sha256,
              human_act_record_input: { human_act_resolution_ref: human.human_act_resolution_ref, event: human.event, idempotency: human.idempotency },
              source_provenance: { schema_version: 1, kind: "echo-meeting-source-provenance-v1", ...context.coordinates,
                source_adapter_kind: "meeting-source", source_adapter_id: source.source.adapter_id, source_adapter_instance_id: source.source.instance_id,
                source_adapter_version: source.source.version, external_id: source.external_id, canonical_revision: source.canonical_revision,
                normalizer_version: source.normalizer_version, source_revision: source.source_revision ?? null },
              processor_provenance: { schema_version: 1, kind: "echo-decision-processor-provenance-v1", ...context.coordinates,
                processor_adapter_kind: "decision-processor", processor_adapter_id: frozen.decisions.processor.adapter_id,
                processor_adapter_instance_id: frozen.decisions.processor.instance_id, processor_adapter_version: frozen.decisions.processor.version,
                processor_contract_sha256: frozen.admission.processor.configuration_sha256 as Sha256Digest },
            }, pinned, lineage, sign) as unknown as JsonObject,
            verify: (value) => verifyOrganizationRecordEnvelopeV4(value, pinned, lineage) as unknown as V4RecordEnvelopeView & JsonObject,
          },
          receipt_factory: {
            createSeed: ({ envelope, position, issued_at, policy_fact_outcome }) => validateOrganizationRecordReceiptBodyV2({
              schema_version: 2, kind: "echo-organization-record-receipt-v2", ...context.coordinates, envelope_id: envelope.body.envelope_id,
              semantic_idempotency_key: envelope.body.semantic_idempotency_key, event_kind: envelope.body.event.kind,
              record_position: position, record_sha256: envelope.record_sha256, predecessor_record_sha256: envelope.body.predecessor_record_sha256,
              record_head_position: position, record_head_sha256: envelope.record_sha256, issued_at, policy_fact_outcome,
            }) as unknown as JsonObject,
            sign: async ({ envelope, receipt_seed }) => {
              if (options.stop_before_receipt?.()) throw new Error("fixture stopped before receipt");
              return await createOrganizationRecordReceiptV2({ envelope: envelope as never,
                record_position: (receipt_seed as { record_position: number }).record_position,
                issued_at: row.issued_at }, pinned, lineage, sign) as unknown as JsonObject;
            },
            verify: ({ receipt, envelope }) => verifyOrganizationRecordReceiptV2(receipt, envelope, pinned, lineage) as unknown as JsonObject,
          },
        });
        if (result.outcome !== "appended" && result.outcome !== "duplicate") throw new Error("fixture append was not durable");
        update({ ...row, phase: "appended" });
      }
      async function appendFinalized() {
        for (const row of read().filter((value) => value.phase === "finalized")) {
          if (row.action === "reject") update({ ...row, phase: "rejected" });
          else await append(row);
        }
      }
      return {
        stager: {
          stage,
          async reconcilePendingDeliveries() {
            for (const frozen of context.state.listPendingApprovalDeliveries()) await stage({ candidate: frozen, admission: frozen.admission, meeting: frozen.meeting, decisions: frozen.decisions });
          },
          async reconcileSuperseded() {
            for (const obsolete of context.state.listPendingSupersededApprovalCards()) {
              const row = read().find((value) => value.approval_id === obsolete.approval_id);
              if (!row) throw new Error("fixture superseded ownership missing");
              update({ ...row, phase: "retired" });
              context.state.recordSupersededApprovalCardTombstoned({ approval_id: row.approval_id, presentation_external_id: `fixture:${row.approval_id}` });
            }
          },
        },
        processing: {
          async recoverV4Appends() { await appendFinalized(); },
          async observeAndFinalizePendingApprovals() {
            for (const row of read().filter((value) => value.phase === "queued")) update({ ...row, phase: "finalized" });
          },
          appendFinalizedApprovalsToV4: appendFinalized,
        },
        interaction_ingress: {
          routes: [{ route_id: "action", method: "POST", path: "/v2/integrations/test-approval/actions" },
            { route_id: "challenge", method: "GET", path: "/v2/integrations/test-approval/actions", accepts_query: true }] as const,
          async accept(request) {
            if (request.route_id === "challenge") return { status: 200 as const, body: { validated: request.query?.get("challenge") === "fixture-challenge" } };
            const action = Buffer.from(request.raw_body).toString("utf8");
            if (action !== "approve" && action !== "reject") throw new Error("fixture action unsupported");
            const row = read()[0];
            if (!row || context.state.readCandidateByApprovalId(row.approval_id)?.state !== "staged") throw new Error("fixture approval is not current");
            if (row.action && row.action !== action) throw new Error("fixture competing action");
            if (row.phase === "presented") update({ ...row, action, phase: "queued" });
            context.on_terminal_action_queued?.();
            return { status: 202 as const, body: { queued: true } };
          },
        },
      };
    },
  };
  return { bundle, read };
}
