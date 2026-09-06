/** Single child process running the existing core through canonical IPC ports. */
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { bootstrapOrganizationAuthorityState } from "../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "../../services/organization-authority/dist/composition/verify-authority-state-lineage.js";
import { openAuthorityDatabase } from "../../services/organization-authority/dist/adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../../services/organization-authority/dist/adapters/security/file-organization-authority-signer.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../../services/organization-authority/dist/processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import { AdmittedMeetingProcessingCycleV1 } from "../../services/organization-authority/dist/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { DEFAULT_MEETING_PROCESSING_WORKER_INTERVAL_MS } from "../../services/organization-authority/dist/processing/admitted-meeting-processing/serialized-meeting-processing-worker.js";
import { startOrganizationAuthorityServiceLifecycle } from "../../services/organization-authority/dist/composition/organization-authority-service-lifecycle.js";
import { createReadableSearchGenerationReconcilerV1 } from "../../services/organization-authority/dist/composition/readable-search-generation-composition.js";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { openOrganizationRecordDatabase, OrganizationRecordAppenderV4, createRecordPolicyFactProjectorRegistryV1, createPrivateSlackBlockApprovalPolicyProjectorV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import { createCoreIdentity } from "./core-identity.mjs";
import { createCoreInput } from "./core-input.mjs";
import { createCoreApproval } from "./core-approval.mjs";
import { createCoreReadRoutes } from "./core-read-routes.mjs";

if (typeof process.send !== "function") throw new Error("run through capacity:checkpoint");
// Any accidental provider fetch fails this checkpoint; no HTTP fixtures exist.
globalThis.fetch = async () => { throw new Error("network is outside the core checkpoint"); };

let runtime;
let identity;
let input;
let approvals;
let state;
let reads;
let authority;
let control;
let record;
let workerError;
let closing;

function close() {
  closing ??= (async () => {
    try { await runtime?.close(); } finally {
      reads?.close();
      identity?.close();
      record?.close();
      control?.close();
      authority?.close();
    }
  })();
  return closing;
}

async function open(state_directory) {
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory,
    organization_display_name: "Core checkpoint organization",
    owner_display_name: "Core Owner",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "capacity-core-stage-one",
  });
  identity = await createCoreIdentity({
    state_directory: initialized.state_directory,
    owner_membership_id: initialized.owner_membership_id,
    pkce_sealing_key: randomBytes(32),
  });
  const { root } = verifyAuthorityStateLineage(initialized.state_directory);
  const coordinates = { authority_id: root.authority_id, organization_id: root.organization_id, state_lineage_id: root.state_lineage_id };
  authority = openAuthorityDatabase(join(state_directory, "authority.sqlite"), { fileMustExist: true });
  control = openOrganizationControlDatabase(join(state_directory, "integrations.sqlite"), { fileMustExist: true });
  record = openOrganizationRecordDatabase(join(state_directory, "record-log.sqlite"), { fileMustExist: true });
  input = createCoreInput({ authority, coordinates, owner: identity.owner, sessions: identity.sessions });
  state = new SqliteAuthorityMeetingProcessingStateV1(authority, input.source_cursor_policy, input.processor.identity.adapter_id);
  const signer = FileOrganizationAuthoritySigner.openExisting({ directory: join(state_directory, "keys"), ...coordinates });
  const projectors = createRecordPolicyFactProjectorRegistryV1([createPrivateSlackBlockApprovalPolicyProjectorV1()]);
  approvals = await createCoreApproval({
    context: {
      state, authority_database: authority, control_plane_database: control,
      record_append: new OrganizationRecordAppenderV4(record, coordinates, projectors),
      signer, coordinates, next_envelope_id: () => `env_${randomUUID()}`,
    },
    owner: identity.owner, employee: identity.employee, sessions: identity.sessions,
  });
  reads = createCoreReadRoutes({ state_directory, sessions: identity.sessions });
  const search = createReadableSearchGenerationReconcilerV1({
    state_directory, root, authority, record, signer,
    policy_projectors: projectors, related_atom_projector: reads.related_atom_projector,
  });
  const source = new AdmittedMeetingProcessingCycleV1({
    source: input.source, processor: input.processor, state, stager: approvals.stager,
    source_cursor_policy: input.source_cursor_policy,
  });
  // These delegates mirror the generic composition root. Phase ordering,
  // recovery, exclusion, wake coalescing and default polling remain production.
  const processing = {
    hasFineGrainedSourceLifecycle: true,
    setWorkerLifecycle: (value) => source.setWorkerLifecycle(value),
    recoverV4Appends: (signal) => approvals.processing.recoverV4Appends(signal),
    pollAndStageAdmittedMeetings: (signal) => source.runOnce(signal),
    observeAndFinalizePendingApprovals: (signal) => approvals.processing.observeAndFinalizePendingApprovals(signal),
    appendFinalizedApprovalsToV4: (signal) => approvals.processing.appendFinalizedApprovalsToV4(signal),
    reconcileReadableSearchGeneration: (signal) => search.reconcile(signal),
  };
  runtime = await startOrganizationAuthorityServiceLifecycle({ api: undefined }, {
    processing,
    // IPC replaces the transport only. The actual application routes above
    // still authenticate every request, fence releases, and persist audits.
    start_api_runtime: async () => ({ address: { address: "core-ipc", family: "IPC", port: 0 }, close: async () => {} }),
    on_worker_error: (error) => { workerError ??= error; },
  });
  return { source: input.source.identity, processor: input.processor.identity, worker_interval_ms: DEFAULT_MEETING_PROCESSING_WORKER_INTERVAL_MS };
}

function status(approval_id) {
  return {
    denied: control.prepare("SELECT COUNT(*) AS n FROM organization_private_approval_denied_action_receipts_v2").get().n,
    terminal: control.prepare("SELECT outcome FROM organization_private_approval_terminal_evidence_v2 WHERE approval_id = ?").get(approval_id) ?? null,
    record_count: record.prepare("SELECT COUNT(*) AS n FROM organization_record_log").get().n,
  };
}

async function command(message) {
  if (message.command === "open") return open(message.state_directory);
  if (workerError) throw new Error(`core worker failed: ${workerError.message}`);
  switch (message.command) {
    case "offer": return input.offer(message.input);
    case "candidate": return await state.readFrozenCandidateForSourceRevision(message.source_revision) ?? null;
    case "presentation": return approvals.poster.readPresentation(message.approval_id) ?? null;
    case "approve": {
      const result = await approvals.offerApproval(message.input);
      runtime.requestApprovalPublication();
      return result;
    }
    case "status": return status(message.approval_id);
    case "search": return reads.search.search({ access_token: identity[message.actor].access_token, query: message.query });
    case "answer": return reads.answer.ask({ access_token: identity[message.actor].access_token, question: message.question });
    case "drain":
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runExclusive(async () => {});
      if (workerError) throw new Error(`core worker failed: ${workerError.message}`);
      return { drained: true };
    case "close": await close(); return { closed: true };
    default: throw new Error("unknown core checkpoint command");
  }
}

process.on("message", async (message) => {
  try {
    const result = await command(message);
    process.send({ id: message.id, result }, () => {
      if (message.command === "close") process.disconnect();
    });
  } catch (error) {
    process.send({ id: message.id, error: { name: error.name, message: error.message } });
  }
});
process.once("disconnect", () => { void close().catch(() => { process.exitCode = 1; }); });
