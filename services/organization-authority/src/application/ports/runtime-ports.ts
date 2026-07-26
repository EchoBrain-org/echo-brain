import type { Buffer } from 'node:buffer';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';

export interface AuthorityClock {
  now(): string;
}

export interface AuthorityIdentifierGenerator {
  next(prefix: 'prn' | 'mem' | 'enr'): string;
}

export interface OrganizationAuthoritySigner {
  inspect(): Promise<OrganizationAuthorityDescriptorV1>;
  sign(message: Buffer, expectedKeyId: Sha256Digest): Promise<Buffer>;
}
