/**
 * Decision-processor adapter implementations belong under this namespace.
 *
 * The bundled structured-text adapter is an explicit-label baseline, not a
 * semantic or model-backed extractor.
 */
export type {
  ActionSignal,
  Adapter,
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterIdentity,
  DecisionSignal,
  DecisionExtractionContext,
  DecisionProcessorAdapter,
  DecisionSet,
  EvidenceSpan,
  MeetingDocument,
  RationaleSignal,
} from '../../core/index.js';

export * from './structured-text/index.js';
