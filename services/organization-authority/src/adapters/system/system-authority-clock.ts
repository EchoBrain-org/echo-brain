import type { AuthorityClock } from '../../application/ports/authority-clock.js';

export class SystemAuthorityClock implements AuthorityClock {
  now(): string {
    return new Date().toISOString();
  }
}
