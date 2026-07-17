/** Neutral authoring surface for meeting-source adapters. */
export type {
  Adapter,
  AdapterConfig,
  AdapterConfigValidation,
  AdapterCursor,
  AdapterHealth,
  AdapterIdentity,
  MeetingBatch,
  MeetingArtifact,
  MeetingCaptureComponent,
  MeetingCaptureState,
  MeetingContentBlock,
  MeetingContext,
  MeetingDocument,
  MeetingGovernance,
  MeetingParticipant,
  MeetingProvenance,
  MeetingPullRequest,
  MeetingSourceAdapter,
  MeetingTime,
} from '../../core/index.js';

/** Compatibility and qualified meeting-source implementations. */
export * as granola from './granola/index.js';
