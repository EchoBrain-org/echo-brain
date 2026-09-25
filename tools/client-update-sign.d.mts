export type ClientUpdateSignerMetadata = Readonly<{
  schema_version: 1;
  kind: 'echo-client-update-signer-v1';
  public_key_spki: string;
  public_key_sha256: string;
}>;

export type ClientUpdateSignSummary = Readonly<{
  status: 'ready_to_sign' | 'signed';
  manifest_sha256: string;
  release_id: string;
  public_key_sha256: string;
  signature_sha256?: string;
}>;

export function initializeClientUpdateSigner(options: Readonly<{ directory: string }>): ClientUpdateSignerMetadata & Readonly<{ status: 'initialized' }>;
export function signClientUpdateFeed(options: Readonly<{
  directory: string;
  prepared: string;
  authorizationPath: string;
  signaturePath: string;
  approveManifest?: string;
  now?: number;
}>): ClientUpdateSignSummary;
