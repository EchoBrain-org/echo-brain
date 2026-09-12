/** Offline observation-cost experiment. No provider/network calls or qualification. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapOrganizationAuthorityState } from "../../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "../../../packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js";
import { openAuthorityDatabase } from "../../../packages/organization-authority-kernel/dist/adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../../../services/organization-authority/dist/adapters/security/file-organization-authority-signer.js";
import { createReadableSearchGenerationReconcilerV1 } from "../../../services/organization-authority/dist/composition/readable-search-generation-composition.js";
import { createStagingJourneyTelemetryTransportV1 } from "../../../services/organization-authority/dist/composition/staging/observability/staging-journey-telemetry-transport-v1.js";
import { observeCoreRuntimeV1, captureCoreRuntimeContentV1 } from "../../../packages/organization-authority-kernel/dist/shared/core-runtime-observation-v1.js";
import { openOrganizationRecordDatabase, createRecordPolicyFactProjectorRegistryV1, createPersonPolicyFactProjectorV2 } from "@echo-brain/organization-record/organization-record-api-v1";
import { clearReadableSearchActiveGenerationV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";

const directory = mkdtempSync(join(tmpdir(), "echo-core-observation-cost-"));
let authority, record;
try {
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: join(directory, "state"), organization_display_name: "Observation fixture", owner_display_name: "Fixture", created_at: "2026-09-08T00:00:00.000Z", creating_artifact_revision: "offline-observation-cost" });
  const lineage = verifyAuthorityStateLineage(initialized.state_directory);
  authority = openAuthorityDatabase(join(initialized.state_directory, "authority.sqlite"), { fileMustExist: true });
  record = openOrganizationRecordDatabase(join(initialized.state_directory, "record-log.sqlite"), { fileMustExist: true });
  const reconciler = createReadableSearchGenerationReconcilerV1({ state_directory: initialized.state_directory, root: lineage.root, authority, record,
    signer: FileOrganizationAuthoritySigner.openExisting({ directory: join(initialized.state_directory, "keys"), authority_id: initialized.authority_id, organization_id: initialized.organization_id }),
    policy_projectors: createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2()]), now: () => "2026-09-08T00:01:00.000Z" });
  const sample = { off: [], metadata: [], content: [] };
  const fixtureContent = "Deterministic non-private fixture evidence. ".repeat(2000);
  for (let round = 0; round < 8; round++) {
    const modes = round % 2 === 0 ? ["off", "metadata", "content"] : ["content", "metadata", "off"];
    for (const mode of modes) {
      let bytes = 0, events = 0;
      const transport = createStagingJourneyTelemetryTransportV1({ release_sha: "a".repeat(40), build_number: 1 }, { write(line) { bytes += Buffer.byteLength(line); events++; } }, { content_enabled: mode === "content" });
      const rssBefore = process.memoryUsage().rss;
      const heapBefore = process.memoryUsage().heapUsed;
      const began = performance.now();
      for (let iteration = 0; iteration < 10; iteration++) {
        // Only this disposable fixture pointer is removed; every pass executes the
        // real snapshot, immutable generation builder, validation and publication.
        authority.prepare("DELETE FROM authority_readable_search_active_generation").run();
        clearReadableSearchActiveGenerationV1();
        const result = await observeCoreRuntimeV1("worker_execution", async () => {
          captureCoreRuntimeContentV1("meeting_input", fixtureContent);
          return reconciler.reconcile(new AbortController().signal);
        }, mode === "off" ? undefined : transport.core_runtime);
        if (result.status !== "published") throw new Error("fixture did not publish");
      }
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const wall_ms = performance.now() - began;
      sample[mode].push({ wall_ms: Number(wall_ms.toFixed(3)), events, output_bytes: bytes, rss_before_bytes: rssBefore, rss_after_bytes: process.memoryUsage().rss, heap_delta_bytes: process.memoryUsage().heapUsed - heapBefore });
      transport.close();
    }
  }
  const median = (values) => { const sorted = [...values].sort((a,b) => a-b); return (sorted[3] + sorted[4]) / 2; };
  process.stdout.write(JSON.stringify({ schema_version: 1, qualification: false, measured_at: new Date().toISOString(), node: process.version,
    workload: "8 alternating batches per mode, 10 real zero-head search snapshot/build/validate/publication passes per batch, identical synthetic content supplied to the observation hook; no model/network calls",
    limitations: ["Empty corpus is an instrumentation experiment, not a capacity or provider benchmark", "RSS/heap are endpoint samples in one process; GC and warm caches affect differences", "Transport writer counts bytes in memory; downstream CloudWatch ingestion cost is not measured"],
    fixture_content_bytes: Buffer.byteLength(fixtureContent),
    median_batch_wall_ms: Object.fromEntries(Object.entries(sample).map(([mode, values]) => [mode, median(values.map((value) => value.wall_ms))])), sample }, null, 2) + "\n");
} finally {
  clearReadableSearchActiveGenerationV1();
  record?.close(); authority?.close(); rmSync(directory, { recursive: true, force: true });
}
