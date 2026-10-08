/** Compatibility adapter for the historical staging metric API and namespace. */
import {
  formatApprovedSearchBacklogMetricsV1 as formatBacklog,
  formatJourneyLivenessMetricV1,
  formatJourneyTelemetryMetricsV1 as formatJourney,
  type ApprovedSearchBacklogSnapshotV1,
} from "../../observability/journey-metrics-v1.js";
export {
  STAGING_JOURNEY_METRICS_NAMESPACE_V1,
  type JourneyEmfMetricDefinitionV1 as StagingJourneyEmfMetricDefinitionV1,
  type JourneyMetricRecordV1 as StagingJourneyMetricRecordV1,
  type ApprovedSearchBacklogSnapshotV1 as StagingApprovedSearchBacklogSnapshotV1,
  type ApprovedSearchBacklogObserverV1 as StagingApprovedSearchBacklogObserverV1,
} from "../../observability/journey-metrics-v1.js";

export const formatJourneyTelemetryMetricsV1: typeof formatJourney = (event, vocabulary) =>
  event.environment === "staging" ? formatJourney(event, vocabulary) : Object.freeze([]);
export const formatStagingJourneyLivenessMetricV1 = (observed_at: string) => formatJourneyLivenessMetricV1(observed_at, "staging");
export const formatApprovedSearchBacklogMetricsV1 = (snapshot: ApprovedSearchBacklogSnapshotV1) => formatBacklog(snapshot, "staging");
