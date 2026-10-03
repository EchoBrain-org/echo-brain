import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { openExtractionAttemptStoreV1 } from "@echo-brain/organization-processing/adapters/persistence/sqlite-extraction-attempt-store-v1";
import type {
  ExtractionAttemptKeyV1,
  ExtractionAttemptOutcomeV1,
} from "@echo-brain/organization-processing/admitted-meeting-processing/extraction-attempt-store-v1";

const USAGE = "usage: extraction-attempts status --state-dir <absolute-path> [--limit <1..100>] | " +
  "retry --state-dir <absolute-path> --admission-sha256 <sha256:digest> --review-lineage-id <rli_digest> " +
  "--review-input-sha256 <sha256:digest> --expected-attempt <number> --expected-outcome <failed|succeeded|pending> " +
  "--confirm-new-model-call [--recover-pending]";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LINEAGE = /^rli_[0-9a-f]{64}$/;
const INTEGER = /^[1-9][0-9]*$/;
const FLAGS = new Set(["--state-dir", "--limit", "--admission-sha256", "--review-lineage-id",
  "--review-input-sha256", "--expected-attempt", "--expected-outcome"]);
const SWITCHES = new Set(["--confirm-new-model-call", "--recover-pending"]);

interface Io { stdout(value: string): void; stderr(value: string): void }
const PROCESS_IO: Io = { stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value) };
type Command = { readonly state: string } & (
  | { readonly action: "status"; readonly limit: number }
  | { readonly action: "retry"; readonly key: ExtractionAttemptKeyV1; readonly attempt: number;
    readonly outcome: ExtractionAttemptOutcomeV1; readonly recoverPending: boolean }
);

function parse(arguments_: readonly string[]): Command {
  const [action, ...args] = arguments_;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (values.has(flag) || (!FLAGS.has(flag) && !SWITCHES.has(flag))) throw new Error(USAGE);
    const value = SWITCHES.has(flag) ? "true" : args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    values.set(flag, value);
  }
  const state = values.get("--state-dir");
  if (state === undefined || !isAbsolute(state)) throw new Error(USAGE);
  if (action === "status") {
    const limit = values.get("--limit") ?? "100";
    if ([...values.keys()].some(flag => flag !== "--state-dir" && flag !== "--limit") ||
      !INTEGER.test(limit) || Number(limit) > 100) throw new Error(USAGE);
    return { action, state, limit: Number(limit) };
  }
  const attempt = values.get("--expected-attempt") ?? "";
  const outcome = values.get("--expected-outcome");
  const key = { admission_sha256: values.get("--admission-sha256") ?? "",
    review_lineage_id: values.get("--review-lineage-id") ?? "",
    review_input_sha256: values.get("--review-input-sha256") ?? "" };
  const recoverPending = values.has("--recover-pending");
  if (action !== "retry" || values.has("--limit") || !values.has("--confirm-new-model-call") ||
    !DIGEST.test(key.admission_sha256) || !LINEAGE.test(key.review_lineage_id) || !DIGEST.test(key.review_input_sha256) ||
    !INTEGER.test(attempt) || Number(attempt) > 2_147_483_647 ||
    (outcome !== "pending" && outcome !== "failed" && outcome !== "succeeded") ||
    (outcome === "pending") !== recoverPending) throw new Error(USAGE);
  return { action, state, key, attempt: Number(attempt), outcome, recoverPending };
}

/** Recovery grants are valid only in the host wrapper's stopped, exclusive worker lane. */
export function runOrganizationAuthorityExtractionAttemptCli(arguments_: readonly string[], io: Io = PROCESS_IO): number {
  const command = parse(arguments_);
  const state = lstatSync(command.state);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Extraction recovery state directory is invalid");
  const { root } = verifyAuthorityStateLineage(command.state);
  const ledger = join(command.state, "extraction-attempts.sqlite");
  const write = (value: Record<string, unknown>) => io.stdout(`${canonicalJson({
    schema_version: 1, kind: "echo-extraction-attempt-recovery-v1", ...value,
  } as never)}\n`);
  // Inspection and retries cannot silently initialize a missing history.
  if (!existsSync(ledger)) {
    if (command.action === "status") { write({ action: "status", ledger_present: false, attempts: [] }); return 0; }
    write({ action: "retry", outcome: "ledger_missing" }); return 1;
  }
  const store = openExtractionAttemptStoreV1(ledger, root);
  try {
    if (command.action === "status") {
      const attempts = store.listLatest(command.limit).map(row => ({
        admission_sha256: row.admission_sha256, review_lineage_id: row.review_lineage_id,
        review_input_sha256: row.review_input_sha256, attempt: row.attempt, outcome: row.outcome,
        failure_code: row.failure_code, retry_authorized: row.retry_authorized,
      }));
      write({ action: "status", ledger_present: true, attempts }); return 0;
    }
    // Reuse is keyed by review input even across admission revisions. Never grant
    // another paid extraction while any frozen candidate already owns that input.
    const authority = new Database(join(command.state, "authority.sqlite"), { readonly: true, fileMustExist: true });
    let frozen: boolean;
    try {
      frozen = authority.prepare(`SELECT 1 FROM authority_live_source_candidates_v2
        WHERE review_lineage_id = ? AND review_input_sha256 = ? LIMIT 1`)
        .get(command.key.review_lineage_id, command.key.review_input_sha256) !== undefined;
    } finally { authority.close(); }
    if (frozen) { write({ action: "retry", outcome: "frozen_candidate_exists" }); return 1; }
    const outcome = store.authorizeRetry({ key: command.key, expected_attempt: command.attempt,
      expected_outcome: command.outcome, ...(command.recoverPending ? { recover_pending: true } : {}) });
    write({ action: "retry", ...command.key, expected_attempt: command.attempt, expected_outcome: command.outcome, outcome });
    return outcome === "authorized" ? 0 : 1;
  } finally { store.close(); }
}
