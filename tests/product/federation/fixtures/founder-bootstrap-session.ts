import { join } from "node:path";
import { canonicalSha256 } from "../../../../src/product/federation/foundation/canonical-json.js";
import { createSignedDocument } from "../../../../src/product/federation/foundation/signed-document.js";
import {
  buildFounderBootstrapConfirmationSummary,
  deriveFounderBootstrapPlanFromSession,
  FounderBootstrapSessionStore,
  validateFounderBootstrapSession,
  type FounderBootstrapSessionV1,
} from "../../../../src/product/federation/bootstrap/bootstrap-session-store.js";
import { commitFounderCutoverGuard } from "../../../../src/product/federation/cutover-fence.js";
import type { InstallationKeyDescriptor } from "../../../../src/product/federation/foundation/installation-signer.js";
import {
  completeBootstrapSessionShapeFixture,
  EXACT_SESSION_AT,
  EXACT_SESSION_IDS,
  TestHardwareSigner,
  type JsonRecord,
} from "./founder-identity.js";

/**
 * The retired bootstrap ceremony was the only thing that produced a valid
 * signed founder-bootstrap session. The cutover fence, the identity check, and
 * the backup downgrade guard all still validate one, so this rebuilds the
 * smallest valid session -- precommit (`ready_for_confirmation`) or irreversible
 * (`committing`/`complete`) -- directly from the retained exact-shape fixture
 * plus the retained derivation helpers.
 *
 * Every self-referential digest is recomputed rather than pinned, so this stays
 * correct if a derivation changes; the exact-shape fixture supplies the rest.
 */

export interface SignedFounderBootstrapSession {
  session: FounderBootstrapSessionV1;
  signer: TestHardwareSigner;
  signingKey: InstallationKeyDescriptor;
}

function asRecord(value: unknown): JsonRecord {
  return value as JsonRecord;
}

/**
 * Recompute the evidence digests the shape fixture leaves as placeholders.
 * `assertCapturedSlackProviderIdentity` and the challenge/verification
 * assertions all recompute these from their own inputs.
 */
function bindProviderEvidence(session: JsonRecord): void {
  const observations = asRecord(session["provider_observations"]);
  const slack = asRecord(observations["slack"]);
  const slackDigest = canonicalSha256(slack["evidence_input"]);
  slack["evidence_sha256"] = slackDigest;
  asRecord(asRecord(slack["provider_identity"])["verification"])[
    "evidence_sha256"
  ] = slackDigest;

  const granola = asRecord(observations["granola"]);
  const granolaDigest = canonicalSha256(granola["evidence"]);
  asRecord(asRecord(granola["provider_identity"])["verification"])[
    "evidence_sha256"
  ] = granolaDigest;

  const challenge = asRecord(session["challenge"]);
  challenge["auth_test_evidence_sha256"] = slackDigest;

  const verification = asRecord(session["verification"]);
  const evidenceInput = asRecord(verification["evidence_input"]);
  asRecord(evidenceInput["bot"])["auth_test_evidence_sha256"] = slackDigest;
  const verificationDigest = canonicalSha256(evidenceInput);
  verification["evidence_sha256"] = verificationDigest;
  asRecord(asRecord(verification["claim_assertion"])["verification"])[
    "evidence_sha256"
  ] = verificationDigest;
}

/**
 * Build one valid signed session at `ready_for_confirmation`, `committing`, or
 * `complete`. The caller gets the signer back so it can create the matching
 * active identity bundle or a second, deliberately different session.
 */
export async function signedFounderBootstrapSession(options: {
  phase: "ready_for_confirmation" | "committing" | "complete";
  sessionId?: string;
  signer?: TestHardwareSigner;
  signingKey?: InstallationKeyDescriptor;
}): Promise<SignedFounderBootstrapSession> {
  const signer = options.signer ?? new TestHardwareSigner();
  const signingKey =
    options.signingKey ??
    (await signer.generate(EXACT_SESSION_IDS.installation_id));

  const draft = completeBootstrapSessionShapeFixture();
  delete draft["integrity"];
  if (options.sessionId !== undefined) draft["session_id"] = options.sessionId;
  draft["phase"] = options.phase;
  // The store admits a brand-new session file only at revision 1, and nothing
  // downstream of the fence reads the revision, so this writes the terminal
  // phase directly instead of replaying the retired ceremony's transitions.
  draft["revision"] = 1;
  draft["signing_key"] = { ...signingKey };
  if (options.phase !== "complete") draft["result"] = null;
  bindProviderEvidence(draft);

  // The confirmation summary and the commit plan are both derived from the
  // session, so they are recomputed here instead of being frozen in the shape
  // fixture, which only has to satisfy the exact-key contract.
  const summary = buildFounderBootstrapConfirmationSummary(
    draft as unknown as FounderBootstrapSessionV1,
  );
  draft["confirmation"] = {
    summary,
    confirmation_sha256: canonicalSha256(summary),
    ready_at: EXACT_SESSION_AT,
  };
  if (options.phase === "ready_for_confirmation") {
    // A precommit session has no commit yet; that is what makes it precommit.
    draft["commit"] = null;
  } else {
    const plan = deriveFounderBootstrapPlanFromSession(
      draft as unknown as FounderBootstrapSessionV1,
      EXACT_SESSION_AT,
    );
    draft["commit"] = {
      confirmed_at: EXACT_SESSION_AT,
      confirmation_sha256: canonicalSha256(summary),
      plan_sha256: canonicalSha256(plan),
      plan,
    };
  }
  if (options.phase === "complete") {
    draft["result"] = {
      completed_at: EXACT_SESSION_AT,
      organization_id: EXACT_SESSION_IDS.organization_id,
      installation_id: EXACT_SESSION_IDS.installation_id,
      manifest_id: EXACT_SESSION_IDS.manifest_id,
      active_bundle_sha256: `sha256:${"7".repeat(64)}`,
    };
  }

  const signed = await createSignedDocument(
    draft as unknown as object,
    signer,
    signingKey.installation_id,
    signingKey.key_id,
  );
  const session = validateFounderBootstrapSession(signed);
  return { session, signer, signingKey };
}

/**
 * Put a valid session on disk the way the retired ceremony left it behind: an
 * irreversible `committing`/`complete` session with its matching external guard
 * by default, or a guardless precommit session with
 * `{ phase: "ready_for_confirmation", withGuard: false }` (the guard derives
 * from the commit, so precommit callers must opt out of it).
 */
export async function writeFencedFounderState(
  stateDirectory: string,
  options: {
    phase?: "ready_for_confirmation" | "committing" | "complete";
    sessionId?: string;
    withGuard?: boolean;
  } = {},
): Promise<SignedFounderBootstrapSession> {
  const built = await signedFounderBootstrapSession({
    phase: options.phase ?? "complete",
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
  });
  new FounderBootstrapSessionStore(stateDirectory).write(built.session);
  if (options.withGuard !== false) {
    commitFounderCutoverGuard(stateDirectory, built.session);
  }
  return built;
}

/** The on-disk location of one session file, for malformed-receipt cases. */
export function founderBootstrapSessionPath(
  stateDirectory: string,
  sessionId: string,
): string {
  return join(
    new FounderBootstrapSessionStore(stateDirectory).directory,
    `session.${sessionId}.v1.json`,
  );
}
