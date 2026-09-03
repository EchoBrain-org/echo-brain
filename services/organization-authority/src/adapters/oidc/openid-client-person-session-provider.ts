import * as openid from 'openid-client';
import type { BegunPersonOidcLogin } from '../../application/person-identity-sessions.js';
import type {
  FrozenPersonSessionOidcConfiguration,
  OidcAuthorizationCodeResult,
  PersonSessionOidcConfiguration,
  PersonSessionOidcProvider,
  VerifiedOidcIdentityToken,
} from '../../application/ports/person-session-dependencies.js';

const DEFAULT_REQUEST_TIMEOUT_SECONDS = 15;
const TERMINAL_CONFIGURATION_FAILURE = {
  kind: 'terminal_failure',
  diagnostic_stage: 'configuration',
} as const;
const TERMINAL_REDEMPTION_FAILURE = {
  kind: 'terminal_failure',
  diagnostic_stage: 'redemption',
} as const;
const TERMINAL_RESPONSE_FAILURE = {
  kind: 'terminal_failure',
  diagnostic_stage: 'response',
} as const;
const TERMINAL_VERIFICATION_FAILURE = {
  kind: 'terminal_failure',
  diagnostic_stage: 'verification',
} as const;

const OIDC_VERIFICATION_ERROR_CODES = new Set([
  'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
  'OAUTH_JWT_TIMESTAMP_CHECK_FAILED',
  'OAUTH_KEY_SELECTION_FAILED',
]);

function terminalFailure(error: unknown): OidcAuthorizationCodeResult {
  const code =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  if (code === 'OAUTH_INVALID_RESPONSE') {
    return TERMINAL_RESPONSE_FAILURE;
  }
  return code !== undefined && OIDC_VERIFICATION_ERROR_CODES.has(code)
    ? TERMINAL_VERIFICATION_FAILURE
    : TERMINAL_REDEMPTION_FAILURE;
}

export type OpenIdClientAuthentication =
  | { method: 'none' }
  | {
      method: 'client_secret_basic' | 'client_secret_post';
      client_secret: string;
    };

export interface OpenIdClientPersonSessionProviderOptions {
  configuration: PersonSessionOidcConfiguration;
  client_authentication: OpenIdClientAuthentication;
  request_timeout_seconds?: number;
  fetch?: openid.CustomFetch;
}

function exactConfiguration(
  left: PersonSessionOidcConfiguration,
  right: PersonSessionOidcConfiguration,
): boolean {
  const tenantMatches =
    left.tenant.kind === right.tenant.kind &&
    (left.tenant.kind === 'issuer' ||
      (right.tenant.kind === 'claim' &&
        left.tenant.claim_name === right.tenant.claim_name &&
        left.tenant.claim_value === right.tenant.claim_value));
  return (
    left.issuer === right.issuer &&
    left.client_id === right.client_id &&
    left.redirect_uri === right.redirect_uri &&
    left.id_token_algorithms.length === 1 &&
    right.id_token_algorithms.length === 1 &&
    left.id_token_algorithms[0] === right.id_token_algorithms[0] &&
    tenantMatches
  );
}

function verifiedToken(
  idToken: unknown,
  claims: Readonly<Record<string, unknown>> | undefined,
): VerifiedOidcIdentityToken | undefined {
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    claims === undefined ||
    typeof claims['iss'] !== 'string' ||
    claims['iss'].length === 0 ||
    typeof claims['sub'] !== 'string' ||
    claims['sub'].length === 0 ||
    typeof claims['nonce'] !== 'string' ||
    claims['nonce'].length === 0 ||
    !Number.isSafeInteger(claims['iat']) ||
    (claims['azp'] !== undefined && typeof claims['azp'] !== 'string')
  ) {
    return undefined;
  }
  const audience = claims['aud'];
  if (
    !(
      (typeof audience === 'string' && audience.length > 0) ||
      (Array.isArray(audience) &&
        audience.length > 0 &&
        audience.every(
          (item) => typeof item === 'string' && item.length > 0,
        ))
    )
  ) {
    return undefined;
  }
  const copiedClaims = Object.freeze({ ...claims });
  return {
    issuer: claims['iss'],
    subject: claims['sub'],
    audience:
      typeof audience === 'string'
        ? audience
        : Object.freeze([...audience] as string[]),
    ...(claims['azp'] === undefined
      ? {}
      : { authorized_party: claims['azp'] }),
    nonce: claims['nonce'],
    issued_at: claims['iat'] as number,
    claims: copiedClaims,
  };
}

/** Provider-neutral OIDC Code + PKCE adapter backed by openid-client v6. */
export class OpenIdClientPersonSessionProvider
  implements PersonSessionOidcProvider
{
  private constructor(
    private readonly configuration: PersonSessionOidcConfiguration,
    private readonly client: openid.Configuration,
  ) {}

  /** Discovers and validates the fixed issuer before any login is admitted. */
  static async discover(
    options: OpenIdClientPersonSessionProviderOptions,
  ): Promise<OpenIdClientPersonSessionProvider> {
    if (options.configuration.id_token_algorithms.length !== 1) {
      throw new Error(
        'Person-session OIDC requires exactly one ID-token algorithm',
      );
    }
    const algorithm = options.configuration.id_token_algorithms[0];
    if (typeof algorithm !== 'string' || algorithm.length === 0) {
      throw new Error('Person-session OIDC ID-token algorithm is invalid');
    }
    const timeout =
      options.request_timeout_seconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('Person-session OIDC request timeout is invalid');
    }

    let authentication: openid.ClientAuth;
    if (options.client_authentication.method === 'none') {
      authentication = openid.None();
    } else if (
      (options.client_authentication.method === 'client_secret_basic' ||
        options.client_authentication.method === 'client_secret_post') &&
      typeof options.client_authentication.client_secret === 'string' &&
      options.client_authentication.client_secret.length > 0
    ) {
      authentication =
        options.client_authentication.method === 'client_secret_basic'
          ? openid.ClientSecretBasic(
              options.client_authentication.client_secret,
            )
          : openid.ClientSecretPost(
              options.client_authentication.client_secret,
            );
    } else {
      throw new Error('Person-session OIDC client authentication is invalid');
    }

    const discoveryOptions: openid.DiscoveryRequestOptions = {
      execute: [openid.enableNonRepudiationChecks],
      timeout,
    };
    if (options.fetch !== undefined) {
      discoveryOptions[openid.customFetch] = options.fetch;
    }
    const client = await openid.discovery(
      new URL(options.configuration.issuer),
      options.configuration.client_id,
      { id_token_signed_response_alg: algorithm },
      authentication,
      discoveryOptions,
    );
    if (client.serverMetadata().issuer !== options.configuration.issuer) {
      throw new Error(
        'Person-session OIDC discovery issuer differs from configured issuer',
      );
    }
    return new OpenIdClientPersonSessionProvider(
      {
        issuer: options.configuration.issuer,
        client_id: options.configuration.client_id,
        redirect_uri: options.configuration.redirect_uri,
        tenant:
          options.configuration.tenant.kind === 'issuer'
            ? { kind: 'issuer' }
            : {
                kind: 'claim',
                claim_name: options.configuration.tenant.claim_name,
                claim_value: options.configuration.tenant.claim_value,
              },
        id_token_algorithms: Object.freeze([algorithm]),
      },
      client,
    );
  }

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    if (
      attempt.issuer !== this.configuration.issuer ||
      attempt.client_id !== this.configuration.client_id ||
      attempt.redirect_uri !== this.configuration.redirect_uri ||
      attempt.response_type !== 'code' ||
      attempt.scope !== 'openid email' ||
      attempt.code_challenge_method !== 'S256'
    ) {
      throw new Error(
        'Person-session OIDC attempt differs from provider configuration',
      );
    }
    return openid
      .buildAuthorizationUrl(this.client, {
        redirect_uri: this.configuration.redirect_uri,
        response_type: 'code',
        scope: 'openid email',
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: attempt.code_challenge,
        code_challenge_method: 'S256',
        // The chooser stays forced. A verified hint only pre-selects the
        // invited account; the Authority still verifies the returned account
        // and can safely return the caller to the chooser if it differs.
        prompt: 'select_account',
        ...(attempt.login_hint === undefined
          ? {}
          : { login_hint: attempt.login_hint }),
      })
      .href;
  }

  async redeemAuthorizationCode(input: {
    configuration: FrozenPersonSessionOidcConfiguration;
    authorization_code: string;
    pkce_verifier: string;
  }): Promise<OidcAuthorizationCodeResult> {
    if (!exactConfiguration(this.configuration, input.configuration)) {
      return TERMINAL_CONFIGURATION_FAILURE;
    }
    try {
      // State is claimed by the application before this call. The application
      // checks the signed nonce and assertion-issuance time after verification.
      const response = await openid.genericGrantRequest(
        this.client,
        'authorization_code',
        {
          code: input.authorization_code,
          redirect_uri: this.configuration.redirect_uri,
          code_verifier: input.pkce_verifier,
        },
      );
      const token = verifiedToken(response.id_token, response.claims());
      return token === undefined
        ? TERMINAL_VERIFICATION_FAILURE
        : { kind: 'verified', token };
    } catch (error) {
      // Once redemption may have begun, replay safety requires terminalization.
      return terminalFailure(error);
    }
  }
}
