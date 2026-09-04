import { AuthorityOperationError } from "../../../../domain/errors.js";
import type {
  MeetingApprovalJourneyClockV1,
  MeetingApprovalJourneyStageAttemptV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "../../../../processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";
import type {
  EnqueuePrivateApprovalInteractionResultV1,
  PrivateApprovalSignedTerminalActionV1,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import type { PrivateSlackApprovalInteractionHttpPortV1 } from "../../../../presentation/private-slack-approval-interaction-http-port-v1.js";
import {
  PrivateSlackApprovalInteractionError,
  parseVerifiedPrivateSlackApprovalInteractionV1,
  type PrivateSlackApprovalInteractionRejectionStageV1,
  verifyPrivateSlackApprovalRequestV1,
} from "./private-slack-approval-interaction-protocol-v1.js";

/**
 * The one durable operation this ingress needs. Keeping this narrow avoids a
 * second queue adapter whose only job was to copy the verified intent into
 * this receipt shape.
 */
export interface PrivateSlackApprovalInteractionResolutionPersistenceV1 {
  enqueue(input: {
    readonly disposition: "resolution";
    readonly receipt: PrivateApprovalSignedTerminalActionV1;
  }):
    | EnqueuePrivateApprovalInteractionResultV1
    | Promise<EnqueuePrivateApprovalInteractionResultV1>;
}

export interface PrivateSlackApprovalInteractionHandlerInputV1 {
  /** Private runtime input. It must never be logged or persisted. */
  readonly signing_secret: string;
  readonly persistence: PrivateSlackApprovalInteractionResolutionPersistenceV1;
  /** Clock for request freshness and durable receipt timestamps. */
  readonly now_unix_seconds?: () => number;
  readonly now?: () => string;
  /** Staging-only durable wait-anchor lookup. It returns no Slack content. */
  readonly read_durable_card_staged_at?: (approval_id: string) => string | null;
  /**
   * Optional staging-only journey telemetry. This must never affect Slack's
   * acknowledgement or durable receipt semantics.
   */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
  /**
   * Observational only. Invoked after a verified terminal action has been
   * durably queued, so the runtime may publish it without waiting for the
   * periodic cycle. Receives no data; its failure never changes the
   * acknowledgement.
   */
  readonly on_action_queued?: () => void;
  /**
   * Observational only. Receives no provider data and is invoked only after a
   * successfully HMAC-verified request fails the parser boundary.
   */
  readonly on_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}

function captureJourneyClock(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
): MeetingApprovalJourneyClockV1 | undefined {
  try {
    return telemetry?.captureClock();
  } catch {
    return undefined;
  }
}

function beginApprovalJourneyStage(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  approvalId: string,
  stage: "meeting_approval_action_verify" | "meeting_approval_action_queue",
  started?: MeetingApprovalJourneyClockV1,
): MeetingApprovalJourneyStageAttemptV1 | null {
  try {
    return telemetry?.beginStageForApproval(approvalId, stage, started) ?? null;
  } catch {
    return null;
  }
}

function approvalQueueAgeMs(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  approvalId: string,
  observedAt: string,
): number | null {
  try {
    return telemetry?.queueAgeMs(approvalId, observedAt) ?? null;
  } catch {
    return null;
  }
}

function restoreDurableCardStaged(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  readStagedAt: ((approval_id: string) => string | null) | undefined,
  approvalId: string,
): void {
  if (telemetry === undefined || readStagedAt === undefined) return;
  try {
    const stagedAt = readStagedAt(approvalId);
    if (stagedAt !== null) telemetry.markCardStaged(approvalId, stagedAt);
  } catch {
    // Durable wait recovery is staging-only and cannot affect interaction ack.
  }
}

function succeedApprovalJourneyStage(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  attempt: MeetingApprovalJourneyStageAttemptV1 | null,
  input?: { readonly queue_age_ms?: number | null },
): void {
  try {
    telemetry?.succeedStage(attempt, input);
  } catch {
    // Telemetry is strictly observational.
  }
}

function failApprovalJourneyStage(
  telemetry: MeetingApprovalJourneyTelemetryPortV1 | undefined,
  attempt: MeetingApprovalJourneyStageAttemptV1 | null,
  error: unknown,
): void {
  try {
    telemetry?.failStage(attempt, error);
  } catch {
    // Telemetry is strictly observational.
  }
}

function reportRejection(
  input: PrivateSlackApprovalInteractionHandlerInputV1,
  stage: PrivateSlackApprovalInteractionRejectionStageV1,
): void {
  try {
    input.on_rejection?.(Object.freeze({ stage }));
  } catch {
    // Diagnostics must never change the provider acknowledgement path.
  }
}

function canonicalNow(now: () => string): string {
  const value = now();
  let canonical: string | undefined;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    canonical = undefined;
  }
  if (canonical !== value) {
    throw new Error("private approval Slack receipt time must be UTC milliseconds");
  }
  return value;
}

function isSlackFormContentType(value: string | undefined): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

/**
 * Verifies and normalizes one Slack interaction before any durable call.
 * Signed policy/comment change events are acknowledged as presentation-only
 * no-ops. Terminal buttons must first be durably queued (or proven an exact
 * replay/denial) before the HTTP layer returns its 200 acknowledgement.
 */
export function createPrivateSlackApprovalInteractionHandlerV1(
  input: PrivateSlackApprovalInteractionHandlerInputV1,
): PrivateSlackApprovalInteractionHttpPortV1 {
  const now = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async accept(
      request: Parameters<
        PrivateSlackApprovalInteractionHttpPortV1["accept"]
      >[0],
    ): Promise<"accepted"> {
      // Capture at ingress so human-action verification latency excludes no
      // work before HTTP acceptance. An unavailable observer is fail-open.
      const acceptedAt = captureJourneyClock(input.journey_telemetry);
      if (!isSlackFormContentType(request.content_type)) {
        throw new AuthorityOperationError(
          "invalid_request",
          "Slack interaction content type is invalid",
        );
      }
      let verified;
      try {
        verified = verifyPrivateSlackApprovalRequestV1({
          raw_body: request.raw_body,
          signing_secret: input.signing_secret,
          headers: {
            "x-slack-request-timestamp": request.slack_request_timestamp,
            "x-slack-signature": request.slack_signature,
          },
          now_unix_seconds:
            input.now_unix_seconds?.() ?? Math.floor(Date.now() / 1_000),
        });
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) {
          throw new AuthorityOperationError(
            "unauthorized",
            "Slack interaction authentication failed",
          );
        }
        throw error;
      }

      let interaction;
      try {
        interaction = parseVerifiedPrivateSlackApprovalInteractionV1(verified);
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) {
          reportRejection(input, error.rejection_stage);
          throw new AuthorityOperationError(
            "invalid_request",
            "Slack interaction payload is invalid",
          );
        }
        throw error;
      }
      if (interaction.disposition === "presentation_change") return "accepted";

      let queueAttempt: MeetingApprovalJourneyStageAttemptV1 | null = null;
      try {
        const observedAt = canonicalNow(now);
        restoreDurableCardStaged(
          input.journey_telemetry,
          input.read_durable_card_staged_at,
          interaction.approval_id,
        );
        const verificationAttempt = beginApprovalJourneyStage(
          input.journey_telemetry,
          interaction.approval_id,
          "meeting_approval_action_verify",
          acceptedAt,
        );
        succeedApprovalJourneyStage(input.journey_telemetry, verificationAttempt, {
          queue_age_ms: approvalQueueAgeMs(
            input.journey_telemetry,
            interaction.approval_id,
            observedAt,
          ),
        });
        queueAttempt = beginApprovalJourneyStage(
          input.journey_telemetry,
          interaction.approval_id,
          "meeting_approval_action_queue",
          captureJourneyClock(input.journey_telemetry),
        );
        const result = await input.persistence.enqueue({
          disposition: "resolution",
          receipt: Object.freeze({
            schema_version: 1,
            kind: "echo-private-approval-signed-block-action-receipt-v1",
            provider_action_key_sha256: interaction.provider_action_key_sha256,
            request: interaction.request,
            approval_id: interaction.approval_id,
            action_id: interaction.action_id,
            action: interaction.action,
            selected_policy_id: interaction.selected_policy_id,
            comment: interaction.comment,
            lookup: interaction.lookup,
            received_at: observedAt,
            verified_at: observedAt,
          }),
        });
        if (result.disposition !== "resolution") {
          throw new Error("private approval terminal receipt was not queued");
        }
        succeedApprovalJourneyStage(input.journey_telemetry, queueAttempt);
        try {
          input.on_action_queued?.();
        } catch {
          // The wake signal is observational; the receipt is already durable.
        }
        return "accepted";
      } catch (error) {
        failApprovalJourneyStage(input.journey_telemetry, queueAttempt, error);
        if (error instanceof AuthorityOperationError) throw error;
        throw new AuthorityOperationError(
          "unavailable",
          "Slack interaction could not be durably queued",
        );
      }
    },
  });
}
