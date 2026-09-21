/**
 * OIDC configuration for the vclaw identity provider (Authelia) plus the pure
 * helpers that build an Authorization Code + PKCE request.
 *
 * Deliberately dependency-free and side-effect-free: `./oidc.ts` (browser),
 * `src/app/routes/auth.callback.tsx`, and `vite.config.ts` (the dev/preview
 * shape-proof middleware) all import it, so it must not touch
 * `import.meta.env`, React, or the DOM at module scope.
 *
 * Values and shapes follow `dash/docs/sprint-buzz-swap/115-OIDC-FORK-PLAN.md`
 * §6.C/§6.D: the `buzz-web` client is PUBLIC
 * (`token_endpoint_auth_method: none`), PKCE is required (this IdP advertises
 * `code_challenge_methods_supported: ["S256"]` only), and the redirect URI is
 * `<app origin>/auth/callback`.
 */

export type OidcConfig = {
  /** Issuer identifier, exactly as it appears in the discovery document. */
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
};

/** Build-time environment keys. Vite inlines `import.meta.env` at build. */
export type OidcEnv = {
  VITE_OIDC_ISSUER?: string;
  VITE_OIDC_CLIENT_ID?: string;
  VITE_OIDC_REDIRECT_URI?: string;
};

export const DEFAULT_OIDC_ISSUER = "https://auth.vclawhub.com";
export const DEFAULT_OIDC_CLIENT_ID = "buzz-web";
export const DEFAULT_OIDC_SCOPES: readonly string[] = [
  "openid",
  "profile",
  "email",
  "groups",
];

/** Client-side login entry point (a route, not an IdP endpoint). */
export const OIDC_LOGIN_PATH = "/login";
/** Path half of the registered redirect URI. */
export const OIDC_CALLBACK_PATH = "/auth/callback";

/**
 * Authelia's authorization endpoint path. The browser NEVER hardcodes an
 * endpoint: it always resolves one from the discovery document. This constant
 * exists only for the dev/preview shape proof in `vite.config.ts`, which must
 * answer before any discovery fetch happens.
 */
export const AUTHELIA_AUTHORIZATION_PATH = "/api/oidc/authorization";

/** Authelia's portal logout path (there is no `end_session_endpoint`). */
export const AUTHELIA_LOGOUT_PATH = "/api/logout";

export function defaultRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${OIDC_CALLBACK_PATH}`;
}

/**
 * Resolve the client configuration. `origin` is `window.location.origin` in
 * the browser and the request origin in the dev middleware, so the production
 * defaults need no per-host rebuild.
 */
export function resolveOidcConfig(
  env: OidcEnv | undefined,
  origin: string,
): OidcConfig {
  const configuredIssuer = env?.VITE_OIDC_ISSUER?.trim();
  const configuredClientId = env?.VITE_OIDC_CLIENT_ID?.trim();
  const configuredRedirectUri = env?.VITE_OIDC_REDIRECT_URI?.trim();
  return {
    issuer: (configuredIssuer || DEFAULT_OIDC_ISSUER).replace(/\/+$/, ""),
    clientId: configuredClientId || DEFAULT_OIDC_CLIENT_ID,
    redirectUri: configuredRedirectUri || defaultRedirectUri(origin),
    scopes: [...DEFAULT_OIDC_SCOPES],
  };
}

/** OIDC discovery document URL for an issuer. */
export function discoveryUrl(config: OidcConfig): string {
  return `${config.issuer}/.well-known/openid-configuration`;
}

/** RFC 4648 §5 base64url, unpadded. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Cryptographically random unpadded base64url (PKCE verifier/state/nonce). */
export function randomUrlSafe(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** PKCE S256 challenge: BASE64URL(SHA-256(ASCII(verifier))), per RFC 7636. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

export type AuthorizationRequestParams = {
  config: OidcConfig;
  authorizationEndpoint: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** `prompt=consent` etc. Omitted when undefined. */
  prompt?: string;
};

/**
 * Build the authorization request URL (response_type=code, PKCE S256).
 *
 * Exported so the dev/preview middleware in `vite.config.ts` can prove the
 * exact parameter set with curl, and so the browser and the proof cannot
 * drift apart.
 */
export function buildAuthorizationUrl({
  config,
  authorizationEndpoint,
  state,
  nonce,
  codeChallenge,
  prompt,
}: AuthorizationRequestParams): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (prompt) {
    query.set("prompt", prompt);
  }
  return `${authorizationEndpoint}?${query.toString()}`;
}
