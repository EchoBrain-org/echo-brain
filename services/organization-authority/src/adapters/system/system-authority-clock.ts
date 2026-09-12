import type { AuthorityClock } from "@echo-brain/organization-authority-kernel/application/ports/authority-clock";

export class SystemAuthorityClock implements AuthorityClock {
  now(): string {
    return new Date().toISOString();
  }
}
