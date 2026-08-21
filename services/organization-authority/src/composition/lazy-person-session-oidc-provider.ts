import type { BegunPersonOidcLogin } from '../application/person-identity-sessions.js';
import type {
  OidcAuthorizationCodeResult,
  PersonSessionOidcProvider,
} from '../application/ports/person-session-runtime.js';

export interface PersonSessionOidcAuthorizationProvider
  extends PersonSessionOidcProvider {
  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string;
}

export type PersonSessionOidcProviderDiscovery =
  () => Promise<PersonSessionOidcAuthorizationProvider>;

/** Caches successful discovery while allowing a later request to retry failure. */
export class LazyPersonSessionOidcProvider
  implements PersonSessionOidcProvider
{
  private provider: PersonSessionOidcAuthorizationProvider | undefined;
  private discovery:
    | Promise<PersonSessionOidcAuthorizationProvider>
    | undefined;

  constructor(
    private readonly discover: PersonSessionOidcProviderDiscovery,
  ) {}

  async acquire(): Promise<PersonSessionOidcAuthorizationProvider> {
    if (this.provider !== undefined) return this.provider;
    const pending = this.discovery ?? this.discover();
    this.discovery = pending;
    try {
      const provider = await pending;
      this.provider = provider;
      return provider;
    } catch (error) {
      if (this.discovery === pending) this.discovery = undefined;
      throw error;
    }
  }

  async redeemAuthorizationCode(
    input: Parameters<PersonSessionOidcProvider['redeemAuthorizationCode']>[0],
  ): Promise<OidcAuthorizationCodeResult> {
    let provider: PersonSessionOidcAuthorizationProvider;
    try {
      provider = await this.acquire();
    } catch {
      return { kind: 'retryable_before_redemption' };
    }
    return provider.redeemAuthorizationCode(input);
  }
}
