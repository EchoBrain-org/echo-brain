/** Compatibility adapter for the historical staging transport contract. */
import {
  createJourneyTelemetryTransportV1,
  createJourneyTelemetryTransportFromEnvironmentV1,
  type JourneyTelemetryIdentityV1,
  type JourneyTelemetryTransportDependenciesV1,
  type JourneyTelemetryTransportOptionsV1,
} from "../../observability/journey-telemetry-transport-v1.js";
import { EMPTY_TELEMETRY_VOCABULARY_V1, type TelemetryVocabularyV1 } from "@echo-brain/organization-authority-kernel/shared/telemetry-vocabulary-v1";
export {
  JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1 as STAGING_JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1,
  JOURNEY_TELEMETRY_LIVENESS_KIND_V1 as STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
  JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1 as STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1,
  APPROVED_SEARCH_BACKLOG_SCHEMA_VERSION_V1 as STAGING_APPROVED_SEARCH_BACKLOG_SCHEMA_VERSION_V1,
  APPROVED_SEARCH_BACKLOG_KIND_V1 as STAGING_APPROVED_SEARCH_BACKLOG_KIND_V1,
  type MeetingApprovalObservationFailureV1,
  type JourneyTelemetryIdentityV1 as StagingJourneyTelemetryIdentityV1,
  type TelemetryRejectionCountsV1 as StagingTelemetryRejectionCountsV1,
  type JourneyTelemetryLivenessEventV1 as StagingJourneyTelemetryLivenessEventV1,
  type ApprovedSearchBacklogEventV1 as StagingApprovedSearchBacklogEventV1,
  type JourneyTelemetryWriterV1 as StagingJourneyTelemetryWriterV1,
  type JourneyTelemetrySchedulerV1 as StagingJourneyTelemetrySchedulerV1,
  type JourneyTelemetryTransportDependenciesV1 as StagingJourneyTelemetryTransportDependenciesV1,
  type JourneyTelemetryTransportOptionsV1 as StagingJourneyTelemetryTransportOptionsV1,
  type JourneyContentObserverV1 as StagingJourneyContentObserverV1,
  type JourneyTelemetryTransportV1 as StagingJourneyTelemetryTransportV1,
} from "../../observability/journey-telemetry-transport-v1.js";

export function createStagingJourneyTelemetryTransportV1(
  identity: JourneyTelemetryIdentityV1,
  dependencies: JourneyTelemetryTransportDependenciesV1,
  options: JourneyTelemetryTransportOptionsV1 = {},
) { return createJourneyTelemetryTransportV1("staging", identity, dependencies, options); }

export function createStagingJourneyTelemetryTransportFromEnvironmentV1(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: JourneyTelemetryTransportDependenciesV1,
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
) { return createJourneyTelemetryTransportFromEnvironmentV1("staging", environment, dependencies, vocabulary); }
