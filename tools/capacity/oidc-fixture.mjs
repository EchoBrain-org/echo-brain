import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function randomOpaque(prefix) {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function rawBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * HTTPS-only synthetic OIDC issuer. It uses an in-memory ephemeral RSA key,
 * serves discovery/JWKS/authorize/token/userinfo, and has no access to the
 * Authority database. TLS material and the trusted CA are verifier-owned.
 */
export function createSyntheticOidcFixture({ tls, client_id, client_secret, subject = "fixture-subject", email = "person@example.test", tenant_claim = { name: "tenant_id", value: "fixture-tenant" }, now_seconds = () => Math.floor(Date.now() / 1000), callbacks = {} }) {
  if (
    tls === null || typeof tls !== "object" || !nonEmpty(tls.key) || !nonEmpty(tls.cert) ||
    !nonEmpty(client_id) || (client_secret !== undefined && !nonEmpty(client_secret)) ||
    !nonEmpty(subject) || !nonEmpty(email) || tenant_claim === null || typeof tenant_claim !== "object" ||
    !nonEmpty(tenant_claim.name) || !nonEmpty(tenant_claim.value)
  ) {
    throw new TypeError("synthetic OIDC fixture configuration is invalid");
  }
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomOpaque("oidc-kid-");
  const publicJwk = Object.freeze({
    ...keys.publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid,
    use: "sig",
  });
  const codes = new Map();
  const accessTokens = new Map();
  const ledger = [];
  let eventId = 0;
  let issuer;

  function append(event) {
    const frozen = Object.freeze({ event_id: ++eventId, at_unix_seconds: now_seconds(), ...event });
    ledger.push(frozen);
    callbacks.on_effect?.(frozen);
  }

  function issueCode(input) {
    const code = input.code ?? randomOpaque("oidc-code-");
    if (!nonEmpty(code) || codes.has(code)) throw new TypeError("synthetic OIDC authorization code is invalid");
    const details = Object.freeze({
      nonce: input.nonce,
      code_challenge: input.code_challenge,
      state: input.state,
      redirect_uri: input.redirect_uri,
      issuer: input.issuer ?? issuer,
      audience: input.audience ?? client_id,
      subject: input.subject ?? subject,
      email: input.email ?? email,
      expires_at: input.expires_at ?? now_seconds() + 300,
      issued_at: input.issued_at ?? now_seconds(),
      tenant_value: input.tenant_value ?? tenant_claim.value,
    });
    if (!nonEmpty(details.nonce) || !nonEmpty(details.code_challenge) || !nonEmpty(details.state) || !nonEmpty(details.redirect_uri)) {
      throw new TypeError("synthetic OIDC authorization code claims are invalid");
    }
    codes.set(code, details);
    return code;
  }

  function idToken(code) {
    const header = base64urlJson({ alg: "RS256", kid, typ: "JWT" });
    const claims = base64urlJson({
      iss: code.issuer,
      sub: code.subject,
      aud: code.audience,
      iat: code.issued_at,
      exp: code.expires_at,
      nonce: code.nonce,
      [tenant_claim.name]: code.tenant_value,
      email: code.email,
      email_verified: true,
    });
    const input = `${header}.${claims}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input, "ascii"), keys.privateKey).toString("base64url")}`;
  }

  const server = createServer(tls, async (request, response) => {
    const origin = issuer;
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      append({ operation: "discovery", accepted: true });
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}authorize`,
        token_endpoint: `${origin}token`,
        userinfo_endpoint: `${origin}userinfo`,
        jwks_uri: `${origin}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jwks") {
      append({ operation: "jwks", accepted: true });
      json(response, 200, { keys: [publicJwk] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const required = ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"];
      if (
        required.some((key) => !nonEmpty(url.searchParams.get(key))) ||
        url.searchParams.get("client_id") !== client_id ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("scope") !== "openid email" ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        append({ operation: "authorize", accepted: false, reason: "invalid-authorize-request" });
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const code = issueCode({
        nonce: url.searchParams.get("nonce"),
        code_challenge: url.searchParams.get("code_challenge"),
        state: url.searchParams.get("state"),
        redirect_uri: url.searchParams.get("redirect_uri"),
      });
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("iss", origin);
      append({ operation: "authorize", accepted: true, authorization_code_sha256: sha256(code), state_sha256: sha256(url.searchParams.get("state")) });
      response.writeHead(302, { location: callback.href }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const body = (await rawBody(request)).toString("utf8");
      const form = new URLSearchParams(body);
      const codeValue = form.get("code");
      const code = codeValue === null ? undefined : codes.get(codeValue);
      const basic = request.headers.authorization;
      let basicClientValid = false;
      if (client_secret !== undefined && /^Basic\s+\S+$/.test(basic ?? "")) {
        try {
          const decoded = Buffer.from((basic ?? "").slice(6), "base64").toString("utf8");
          const delimiter = decoded.indexOf(":");
          basicClientValid =
            delimiter > 0 &&
            decodeURIComponent(decoded.slice(0, delimiter)) === client_id &&
            decodeURIComponent(decoded.slice(delimiter + 1)) === client_secret;
        } catch {
          basicClientValid = false;
        }
      }
      const clientValid = client_secret === undefined
        ? basic === undefined && form.get("client_id") === client_id
        : (/^Basic\s+\S+$/.test(basic ?? "") && basicClientValid) || (form.get("client_id") === client_id && form.get("client_secret") === client_secret);
      const tokenRequestValid =
        code !== undefined && form.get("grant_type") === "authorization_code" &&
        form.get("redirect_uri") === code.redirect_uri && form.get("code_verifier") !== null &&
        pkceChallenge(form.get("code_verifier")) === code.code_challenge && clientValid;
      if (!tokenRequestValid) {
        append({ operation: "token", accepted: false, reason: "invalid-token-request", authorization_code_sha256: codeValue === null ? null : sha256(codeValue) });
        json(response, 400, { error: "invalid_grant" });
        return;
      }
      codes.delete(codeValue);
      const accessToken = randomOpaque("oidc-access-");
      accessTokens.set(accessToken, code);
      append({ operation: "token", accepted: true, authorization_code_sha256: sha256(codeValue), request_sha256: sha256(body) });
      json(response, 200, { access_token: accessToken, token_type: "Bearer", id_token: idToken(code) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/userinfo") {
      const token = /^Bearer\s+(.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const code = token === undefined ? undefined : accessTokens.get(token);
      if (code === undefined) {
        append({ operation: "userinfo", accepted: false, reason: "invalid-access-token" });
        json(response, 401, { error: "invalid_token" });
        return;
      }
      append({ operation: "userinfo", accepted: true, access_token_sha256: sha256(token) });
      json(response, 200, { sub: code.subject, email: code.email, email_verified: true, [tenant_claim.name]: code.tenant_value });
      return;
    }
    response.writeHead(404).end();
  });

  return Object.freeze({
    async listen(port = 0, host = "localhost") {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("synthetic OIDC issuer has no TCP address");
      issuer = `https://localhost:${address.port}/`;
      return issuer;
    },
    issue_authorization_code(input) {
      if (issuer === undefined) throw new Error("synthetic OIDC issuer is not listening");
      return issueCode(input);
    },
    ledger() {
      return Object.freeze(ledger.map((event) => Object.freeze({ ...event })));
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  });
}

/**
 * A narrow custom Fetch for `openid-client` tests. It explicitly supplies a
 * verifier CA to Node's HTTPS client and leaves certificate verification on.
 */
export function createTrustedOidcFetch({ ca }) {
  if (!nonEmpty(ca)) throw new TypeError("trusted OIDC CA is invalid");
  return async (input, init = {}) => {
    const source = input instanceof Request ? input : undefined;
    const url = new URL(source?.url ?? input);
    const headers = new Headers(source?.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    let body = init.body ?? source?.body;
    if (body instanceof URLSearchParams) {
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = body.toString();
    }
    if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      throw new TypeError("trusted OIDC fetch body is unsupported");
    }
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(url, {
        method: init.method ?? source?.method ?? "GET",
        headers: Object.fromEntries(headers),
        ca,
        rejectUnauthorized: true,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          headers: response.headers,
        })));
      });
      request.once("error", reject);
      if (init.signal !== undefined) {
        if (init.signal.aborted) request.destroy(init.signal.reason);
        else init.signal.addEventListener("abort", () => request.destroy(init.signal.reason), { once: true });
      }
      if (body !== undefined && body !== null) request.write(body);
      request.end();
    });
  };
}
