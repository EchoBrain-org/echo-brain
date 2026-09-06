import type { StagingReleaseTarget } from './authority-staging-release.mjs';

export class InvitationExportError extends Error { readonly code: string; }
export type InvitationExportRequest = {
  schema_version: 1;
  kind: 'echo-staging-invitation-export-v1';
  state: 'planned' | 'submitting' | 'submitted' | 'failed' | 'complete';
  request_id: string;
  target: StagingReleaseTarget;
  release_sha256: string;
  release_base64: string;
  public_key: string;
  source_sha256: string;
  binding_sha256: string;
  command_id: string | null;
  invitation_sha256: string | null;
};
export type InvitationExportDependencies = {
  aws?(args: readonly string[]): unknown;
  sleep?(milliseconds: number): void;
  now?(): number;
};
export function planInvitationExport(input: string, dependencies?: InvitationExportDependencies): {
  action: 'export-plan'; state: 'planned'; receipt_path: string;
  target: StagingReleaseTarget; release_id: string; release_sha256: string;
  files: readonly string[]; remote_access: string; infrastructure_changes: false;
};
export function executeInvitationExport(receipt: string, dependencies?: InvitationExportDependencies): {
  action: 'export-execute'; state: 'exported'; release_id: string;
  invitation_path: string; release_path: string;
};
export function invitationExportCommands(request: InvitationExportRequest): readonly string[];
export function sealInvitationPayload(payload: Buffer, recipient: string, aad: string): {
  version: 1; key: string; iv: string; tag: string; data: string;
};
export function openInvitationPayload(output: string, privateKey: Buffer, request: InvitationExportRequest): {
  release: Buffer; invitation: Buffer;
};
