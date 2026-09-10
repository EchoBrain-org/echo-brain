import { createHash } from "node:crypto";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import * as oidc from "openid-client";

export interface SlackBrowserIdentityProvider {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    workspace_id: string;
    code_verifier: string;
  }): string;
  verifyCallback(input: {
    body: URLSearchParams;
    expectedState: string;
    expectedNonce: string;
    workspace_id: string;
    code_verifier: string;
  }): Promise<{
    user_id: string;
    team_id: string;
    verification_evidence_sha256: `sha256:${string}`;
  }>;
}

// Pin the provider endpoints: neither client input nor callback data chooses a host.
export function createSlackBrowserIdentityProvider(options: {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  fetch?: oidc.CustomFetch;
}): SlackBrowserIdentityProvider {
  const redirect = new URL(options.redirect_uri);
  if (redirect.protocol !== "https:" || redirect.username || redirect.password ||
      redirect.search || redirect.hash ||
      redirect.pathname !== "/v2/person/external-identities/slack/browser/callback" ||
      !options.client_id.trim() || !options.client_secret.trim()) {
    throw new Error("Invalid Slack browser connection configuration");
  }
  const config = new oidc.Configuration({
    issuer: "https://slack.com",
    authorization_endpoint: "https://slack.com/openid/connect/authorize",
    token_endpoint: "https://slack.com/api/openid.connect.token",
    jwks_uri: "https://slack.com/openid/connect/keys",
  }, options.client_id, { id_token_signed_response_alg: "RS256" },
  oidc.ClientSecretPost(options.client_secret));
  config.timeout = 15;
  if (options.fetch) config[oidc.customFetch] = options.fetch;
  // Token endpoint TLS alone does not verify the ID token's signature.
  oidc.enableNonRepudiationChecks(config);

  return {
    authorizationUrl(input) {
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirect.href,
        scope: "openid profile",
        response_type: "code",
        response_mode: "form_post",
        team: input.workspace_id,
        state: input.state,
        nonce: input.nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(input.code_verifier).digest("base64url"),
      }).href;
    },
    async verifyCallback(input) {
      try {
        if (input.body.getAll("state").length !== 1 ||
            input.body.get("state") !== input.expectedState ||
            input.body.getAll("code").length !== 1 ||
            !input.body.get("code") || input.body.get("code")!.length > 4096 ||
            input.body.has("error")) throw new Error();
        const tokens = await oidc.authorizationCodeGrant(config, new Request(redirect, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: input.body,
        }), {
          expectedState: input.expectedState,
          expectedNonce: input.expectedNonce,
          pkceCodeVerifier: input.code_verifier,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        const team_id = claims?.["https://slack.com/team_id"];
        const user_id = claims?.["https://slack.com/user_id"];
        const now = Math.floor(Date.now() / 1000);
        if (!claims || !tokens.id_token ||
            typeof team_id !== "string" || team_id !== input.workspace_id ||
            typeof user_id !== "string" || !/^[UW][A-Z0-9]{2,127}$/.test(user_id) ||
            typeof claims.sub !== "string" || !claims.sub ||
            typeof claims.iat !== "number" || claims.iat > now + 30 ||
            claims.iat < now - 600) throw new Error();
        return {
          user_id, team_id,
          verification_evidence_sha256: canonicalSha256({
            kind: "echo-slack-oidc-identity-proof-v1",
            issuer: "https://slack.com",
            client_id: options.client_id,
            team_id, user_id, subject: claims.sub, issued_at: claims.iat,
            identity_token_sha256: `sha256:${createHash("sha256").update(tokens.id_token).digest("hex")}`,
          }),
        };
      } catch {
        // OAuth responses can include secrets and provider-controlled text.
        throw new Error("Slack identity verification failed");
      }
    },
  };
}
