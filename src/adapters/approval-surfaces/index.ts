/**
 * Approval-surface adapter implementations belong under this namespace.
 *
 * An approval surface is where a human resolves a pending decision brief
 * (approve/reject + reason). Surfaces write into the shared decision node
 * store, so any configured surface and the CLI stay interchangeable.
 */
export type {
  Adapter,
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterIdentity,
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
  ApprovalSurfaceAdapter,
  DecisionBrief,
} from '@echo-brain/organization-authority/processing/core/index.js';

export * from './slack-reactions/index.js';
