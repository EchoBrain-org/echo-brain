import { randomBytes } from 'node:crypto';
import { federationId } from '@echo-brain/federation-protocol';
import type {
  AuthorityClock,
  AuthorityIdentifierGenerator,
  EnrollmentGrantGenerator,
} from '../../application/ports/runtime-ports.js';

export class SystemAuthorityClock implements AuthorityClock {
  now(): string {
    return new Date().toISOString();
  }
}

export class RandomAuthorityIdentifierGenerator implements AuthorityIdentifierGenerator {
  next(prefix: 'prn' | 'mem' | 'enr'): string {
    return federationId(prefix);
  }
}

export class CryptoEnrollmentGrantGenerator implements EnrollmentGrantGenerator {
  generate(): Uint8Array {
    return Uint8Array.from(randomBytes(32));
  }
}
