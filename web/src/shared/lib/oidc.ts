/**
 * OIDC / OAuth 2.0 Authorization Code + PKCE for the vclaw identity provider
 * (Authelia at `https://auth.vclawhub.com`).
 *
 * This module owns discovery, PKCE, the authorization request, the code
 * exchange, an optional refresh grant, expiry, and logout — plus the two
 * sessionStorage records the app keeps, so the React layer
 * (`./session.tsx`) and non-React callers (the relay credential seam in
 * `./relay-auth.ts`) read one source of truth.
 *
 * STORAGE POLICY (deliberate: the shipped app persisted nothing at all).
 * - sessionStorage only. No localStorage, no cookies, nothing cross-tab,
 *   nothing that outlives the tab.
 * - Two records: `buzz-oidc-flow` (state + nonce + code_verifier, single use,
 *   10-minute TTL) and `buzz-oidc-session` (tokens).
 * - Absolute cap `SESSION_MAX_LIFETIME_MS` (12 h): past it the session is
 *   dropped and the human signs in again, whatever the IdP token lifetimes
 *   say. The IdP has no `end_session_endpoint` and no per-user revocation on
 *   4.38 (115-OIDC-FORK-PLAN.md §3), so this cap is the only client-side kill
 *   switch; a refresh grant is honoured only inside the cap.
 *
 * TRUST: the id_token payload is decoded LOCALLY and is NOT verified here —
 * this module never checks the signature and the claims are for display only.
 * Authorization decisions belong to the relay/issuer, which verifies the
 * assertion against the issuer JWKS (NIP-FI, 115-OIDC-FORK-PLAN.md §5).
 */

import {
  AUTHELIA_LOGOUT_PATH,
  buildAuthorizationUrl,
  discoveryUrl,
  type OidcConfig,
  type OidcEnv,
  pkceChallenge,
  randomUrlSafe,
  resolveOidcConfig,
} from "./oidc-config";
import { safeReturnTo } from "./return-to";

/** sessionStorage key for the in-flight authorization request (single use). */
export const FLOW_STORAGE_KEY = "buzz-oidc-flow";
/** sessionStorage key for the signed-in session. */
export const SESSION_STORAGE_KEY = "buzz-oidc-session";

/** An unfinished authorization request is abandoned after this long. */
export const FLOW_TTL_MS = 10 * 60 * 1_000;
/** Absolute client-side session cap (see STORAGE POLICY above). */
export const SESSION_MAX_LIFETIME_MS = 12 * 60 * 60 * 1_000;
/** Treat a token as expired this long before its stated expiry. */
export const EXPIRY_SKEW_MS = 30_000;
/** Fallback when the token response omits `expires_in`. */
const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 5 * 60 * 1_000;
const DISCOVERY_TTL_MS = 10 * 60 * 1_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;

const STORAGE_VERSION = 1;

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
  code_challenge_methods_supported?: string[];
};

export type IdTokenClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  groups?: string[];
};

/**
 * The signed-in human, as far as the browser can see: the decoded id_token
 * payload. DISPLAY ONLY — never use these values for an authorization
 * decision (see the TRUST note at the top of this file).
 */
export type SessionPrincipal = {
  subject: string;
  email: string | null;
  preferredUsername: string | null;
  name: string | null;
  groups: string[];
  claims: IdTokenClaims;
};

export type OidcTokens = {
  accessToken: string;
  idToken: string | null;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
};

export type OidcSession = {
  version: number;
  tokens: OidcTokens;
  /** Epoch milliseconds of the first successful exchange in this tab. */
  signedInAt: number;
};

export type StoredFlow = {
  version: number;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  returnTo: string | null;
  startedAt: number;
};

/** A typed failure with a stable machine-readable `code`. */
export class OidcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OidcError(code, message);
}

/* ------------------------------------------------------------------ config */

export function appOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * Config from the build-time environment, with production-safe defaults
 * (`VITE_OIDC_ISSUER` https://auth.vclawhub.com, client `buzz-web`, redirect
 * `${origin}/auth/callback`). The redirect default is origin-derived, so one
 * build serves any host without a rebuild.
 */
export function currentOidcConfig(): OidcConfig {
  return resolveOidcConfig(import.meta.env as OidcEnv, appOrigin());
}

/* --------------------------------------------------------------- discovery */

let discoveryCache: {
  key: string;
  fetchedAt: number;
  value: OidcDiscovery;
} | null = null;

/**
 * Fetch and cache the issuer's discovery document (in memory, 10 minutes;
 * a full page load re-fetches). Cached in memory rather than storage because
 * it is cheap, public, and must never be trusted from a previous session.
 */
export async function fetchDiscovery(
  config: OidcConfig,
  options?: { force?: boolean },
): Promise<OidcDiscovery> {
  const url = discoveryUrl(config);
  const cached = discoveryCache;
  if (
    !options?.force &&
    cached &&
    cached.key === url &&
    Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS
  ) {
    return cached.value;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    return fail(
      "discovery_unreachable",
      `Could not reach the identity provider at ${config.issuer}.`,
    );
  }
  if (!response.ok) {
    return fail(
      "discovery_failed",
      `The identity provider discovery document returned HTTP ${response.status}.`,
    );
  }
  const document = (await response
    .json()
    .catch(() => null)) as OidcDiscovery | null;
  if (
    !document ||
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string"
  ) {
    return fail(
      "discovery_malformed",
      "The identity provider discovery document is missing required endpoints.",
    );
  }
  discoveryCache = { key: url, fetchedAt: Date.now(), value: document };
  return document;
}

/* ------------------------------------------------------- storage primitives */

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage can be blocked (private mode, enterprise policy).
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = storage();
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the session simply will not survive a reload.
  }
}

function remove(key: string): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
}

/** Read the in-flight flow once and consume it (single use, by design). */
export function consumeStoredFlow(): StoredFlow | null {
  const flow = readJson<StoredFlow>(FLOW_STORAGE_KEY);
  remove(FLOW_STORAGE_KEY);
  if (!flow || flow.version !== STORAGE_VERSION) {
    return null;
  }
  if (Date.now() - flow.startedAt > FLOW_TTL_MS) {
    return null;
  }
  return flow;
}

/** Drop any unfinished authorization request (e.g. on sign-out). */
export function clearStoredFlow(): void {
  remove(FLOW_STORAGE_KEY);
}

/** The stored session, or null when absent, malformed, or past the cap. */
export function readStoredSession(): OidcSession | null {
  const session = readJson<OidcSession>(SESSION_STORAGE_KEY);
  if (!session || session.version !== STORAGE_VERSION) {
    return null;
  }
  if (typeof session.signedInAt !== "number") {
    return null;
  }
  if (Date.now() - session.signedInAt > SESSION_MAX_LIFETIME_MS) {
    clearStoredSession();
    return null;
  }
  return session;
}

export function clearStoredSession(): void {
  remove(SESSION_STORAGE_KEY);
}

/* -------------------------------------------------------------------- PKCE */

export type AuthorizationRequest = {
  url: string;
  flow: StoredFlow;
};

/**
 * Build an authorization request and remember the PKCE verifier + state in
 * sessionStorage. The caller navigates to `url`; `state` sent to the IdP is
 * echoed back and compared in `completeAuthorizationCallback`.
 */
export async function createAuthorizationRequest(
  config: OidcConfig,
  options?: {
    returnTo?: string | null;
    prompt?: string;
    discovery?: OidcDiscovery;
  },
): Promise<AuthorizationRequest> {
  const discovery = options?.discovery ?? (await fetchDiscovery(config));
  if (
    Array.isArray(discovery.code_challenge_methods_supported) &&
    !discovery.code_challenge_methods_supported.includes("S256")
  ) {
    return fail(
      "pkce_unsupported",
      "The identity provider does not advertise PKCE S256.",
    );
  }
  const state = randomUrlSafe(32);
  const nonce = randomUrlSafe(32);
  const codeVerifier = randomUrlSafe(64);
  // `?returnTo=` is URL input and this value is navigated to AFTER sign-in
  // (`app/routes/auth.callback.tsx`), so it is classified HERE — the single
  // point where an untrusted value enters the persisted flow — and stored only
  // when it is provably a same-origin absolute path. A refused value becomes
  // `/`, and so does an absent one; `./return-to.ts` holds the rule and the
  // defect it closes.
  const returnTo = safeReturnTo(options?.returnTo);
  const flow: StoredFlow = {
    version: STORAGE_VERSION,
    state,
    nonce,
    codeVerifier,
    redirectUri: config.redirectUri,
    issuer: config.issuer,
    clientId: config.clientId,
    // Classified above: always a same-origin absolute path.
    returnTo,
    startedAt: Date.now(),
  };
  writeJson(FLOW_STORAGE_KEY, flow);
  const url = buildAuthorizationUrl({
    config,
    authorizationEndpoint: discovery.authorization_endpoint,
    state,
    nonce,
    codeChallenge: await pkceChallenge(codeVerifier),
    prompt: options?.prompt,
  });
  return { url, flow };
}

/* ------------------------------------------------------------------ tokens */

type TokenEndpointResponse = {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
};

function parseTokenResponse(
  body: TokenEndpointResponse,
  fallback?: OidcTokens,
): OidcTokens {
  if (typeof body.access_token !== "string" || body.access_token === "") {
    return fail(
      "invalid_token_response",
      "The identity provider returned no access token.",
    );
  }
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? body.expires_in
      : null;
  const refreshToken =
    typeof body.refresh_token === "string"
      ? body.refresh_token
      : (fallback?.refreshToken ?? null);
  return {
    accessToken: body.access_token,
    idToken:
      typeof body.id_token === "string"
        ? body.id_token
        : (fallback?.idToken ?? null),
    refreshToken,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    scope:
      typeof body.scope === "string" ? body.scope : (fallback?.scope ?? null),
    expiresAt:
      Date.now() +
      (expiresIn === null
        ? DEFAULT_ACCESS_TOKEN_LIFETIME_MS
        : expiresIn * 1_000),
  };
}

async function postTokenRequest(
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<OidcTokens> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      // Public client: no client secret, no cookies. The IdP must answer with
      // CORS headers for the app origin (identity_providers.oidc.cors.endpoints
      // — enabled by the lead, 115-OIDC-FORK-PLAN.md §2).
      credentials: "omit",
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return fail(
      "token_endpoint_unreachable",
      "Could not reach the identity provider token endpoint. If this is a cross-origin failure, the issuer must allow this origin for /api/oidc/token.",
    );
  }
  const payload = (await response
    .json()
    .catch(() => ({}))) as TokenEndpointResponse;
  if (!response.ok) {
    const code =
      typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : `the token endpoint returned HTTP ${response.status}`;
    return fail(code, `Sign-in was refused: ${detail}.`);
  }
  return parseTokenResponse(payload);
}

/** Redeem an authorization code. Public client: no secret, PKCE verifier only. */
export async function exchangeAuthorizationCode(params: {
  config: OidcConfig;
  discovery: OidcDiscovery;
  code: string;
  codeVerifier: string;
}): Promise<OidcTokens> {
  return postTokenRequest(
    params.discovery.token_endpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.config.redirectUri,
      client_id: params.config.clientId,
      code_verifier: params.codeVerifier,
    }),
  );
}

/**
 * Optional refresh grant. Returns the tokens unchanged when there is nothing
 * to refresh. Requires `offline_access`/a refresh token to have been issued;
 * the registered `buzz-web` client does not request that scope today, so this
 * path is wired but not exercised (115-OIDC-FORK-PLAN.md §6.C).
 */
export async function refreshSession(): Promise<OidcSession> {
  const session = readStoredSession();
  if (!session) {
    return fail("no_session", "There is no signed-in session to refresh.");
  }
  if (!session.tokens.refreshToken) {
    return session;
  }
  const config = currentOidcConfig();
  const discovery = await fetchDiscovery(config);
  const tokens = await postTokenRequest(
    discovery.token_endpoint,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.tokens.refreshToken,
      client_id: config.clientId,
    }),
  );
  const refreshed: OidcSession = {
    version: STORAGE_VERSION,
    tokens,
    signedInAt: session.signedInAt,
  };
  writeJson(SESSION_STORAGE_KEY, refreshed);
  return refreshed;
}

/* ------------------------------------------------------- callback + claims */

/** base64url → UTF-8 string (for the id_token payload). */
function base64UrlDecodeToString(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Decode the id_token payload. DISPLAY ONLY: the signature is never checked
 * here, so nothing from this object may gate access (see the TRUST note).
 */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(base64UrlDecodeToString(parts[1]));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as IdTokenClaims;
  } catch {
    return null;
  }
}

function principalFromClaims(claims: IdTokenClaims): SessionPrincipal | null {
  if (typeof claims.sub !== "string" || claims.sub === "") {
    return null;
  }
  return {
    subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    preferredUsername:
      typeof claims.preferred_username === "string"
        ? claims.preferred_username
        : null,
    name: typeof claims.name === "string" ? claims.name : null,
    groups: Array.isArray(claims.groups)
      ? claims.groups.filter(
          (group): group is string => typeof group === "string",
        )
      : [],
    claims,
  };
}

/** The principal of a stored session, or null when the id_token is unusable. */
export function principalFromSession(
  session: OidcSession | null,
): SessionPrincipal | null {
  if (!session?.tokens.idToken) {
    return null;
  }
  const claims = decodeIdTokenClaims(session.tokens.idToken);
  return claims ? principalFromClaims(claims) : null;
}

export type CompletedSignIn = {
  session: OidcSession;
  principal: SessionPrincipal | null;
  returnTo: string | null;
};

/**
 * Memoised per (code, state): React StrictMode mounts effects twice, and an
 * authorization code is single use — the second call must observe the first
 * call's result instead of trying to redeem the code again.
 */
const inFlightSignIns = new Map<string, Promise<CompletedSignIn>>();

export function completeAuthorizationCallback(
  params: { code: string; state: string },
  config: OidcConfig = currentOidcConfig(),
): Promise<CompletedSignIn> {
  const key = `${params.code}\u0000${params.state}`;
  const existing = inFlightSignIns.get(key);
  if (existing) {
    return existing;
  }
  const attempt = runCompleteAuthorizationCallback(params, config);
  inFlightSignIns.set(key, attempt);
  void attempt.catch(() => inFlightSignIns.delete(key));
  return attempt;
}

/**
 * Finish the authorization response: validate `state` against the stored flow
 * (FAIL CLOSED — a mismatch never reaches the token endpoint), exchange the
 * code, sanity-check the id_token claims, then store the session.
 */
async function runCompleteAuthorizationCallback(
  params: { code: string; state: string },
  config: OidcConfig,
): Promise<CompletedSignIn> {
  const flow = consumeStoredFlow();
  if (!flow) {
    // Already signed in (e.g. React StrictMode re-running the effect): keep it.
    const existing = readStoredSession();
    if (existing) {
      return {
        session: existing,
        principal: principalFromSession(existing),
        returnTo: null,
      };
    }
    return fail(
      "no_signin_in_progress",
      "This sign-in response does not belong to a sign-in started in this tab. Start again from the sign-in button; nothing was stored.",
    );
  }
  if (flow.state !== params.state) {
    return fail(
      "state_mismatch",
      "The sign-in response did not match the request this tab started (state mismatch). Nothing was stored.",
    );
  }
  if (
    flow.redirectUri !== config.redirectUri ||
    flow.clientId !== config.clientId
  ) {
    return fail(
      "config_changed",
      "The sign-in request was started with a different client or redirect URI. Start again; nothing was stored.",
    );
  }

  const discovery = await fetchDiscovery(config);
  const tokens = await exchangeAuthorizationCode({
    config,
    discovery,
    code: params.code,
    codeVerifier: flow.codeVerifier,
  });

  // Local consistency checks on an UNVERIFIED token: they catch configuration
  // mistakes and crossed flows, and are not a security boundary.
  const claims = tokens.idToken ? decodeIdTokenClaims(tokens.idToken) : null;
  if (!claims) {
    return fail(
      "invalid_id_token",
      "The identity provider returned no usable id_token. Nothing was stored.",
    );
  }
  if (claims.iss !== undefined && claims.iss !== config.issuer) {
    return fail(
      "issuer_mismatch",
      `The id_token was issued by ${claims.iss}, not ${config.issuer}. Nothing was stored.`,
    );
  }
  const audiences = Array.isArray(claims.aud)
    ? claims.aud
    : claims.aud === undefined
      ? []
      : [claims.aud];
  if (audiences.length > 0 && !audiences.includes(config.clientId)) {
    return fail(
      "audience_mismatch",
      "The id_token was issued for a different client. Nothing was stored.",
    );
  }
  if (claims.nonce !== flow.nonce) {
    return fail(
      "nonce_mismatch",
      "The id_token nonce did not match this sign-in attempt. Nothing was stored.",
    );
  }

  const session: OidcSession = {
    version: STORAGE_VERSION,
    tokens,
    signedInAt: Date.now(),
  };
  writeJson(SESSION_STORAGE_KEY, session);
  return {
    session,
    principal: principalFromClaims(claims),
    returnTo: flow.returnTo,
  };
}

/* ------------------------------------------------------------- expiry + API */

export function isExpired(expiresAt: number, skewMs = EXPIRY_SKEW_MS): boolean {
  return Date.now() + skewMs >= expiresAt;
}

/**
 * A usable access token, refreshing once when needed. Returns null when there
 * is no session or the session cannot be renewed (in which case the stale
 * session is cleared).
 */
export async function getValidAccessToken(): Promise<string | null> {
  const session = readStoredSession();
  if (!session) {
    return null;
  }
  if (!isExpired(session.tokens.expiresAt)) {
    return session.tokens.accessToken;
  }
  if (!session.tokens.refreshToken) {
    clearStoredSession();
    return null;
  }
  try {
    return (await refreshSession()).tokens.accessToken;
  } catch {
    clearStoredSession();
    return null;
  }
}

/**
 * Best-effort portal logout at the IdP. Authelia 4.38 has no
 * `end_session_endpoint` and its portal logout is `POST /api/logout` (200
 * today). This call is cross-origin and unverifiable from the page: it uses
 * `no-cors` because a browser cannot read the response, and it may not carry
 * the Authelia session cookie under SameSite=Lax. LOCAL STATE IS ALWAYS
 * CLEARED FIRST, so a failure here never leaves the app signed in.
 *
 * TODO(115-OIDC-FORK-PLAN.md §6.F): replace with `end_session_endpoint` if the
 * IdP ever publishes one.
 */
async function notifyPortalLogout(): Promise<void> {
  const config = currentOidcConfig();
  try {
    await fetch(`${config.issuer}${AUTHELIA_LOGOUT_PATH}`, {
      method: "POST",
      mode: "no-cors",
      credentials: "include",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best effort only; local state is already gone.
  }
}

/** Clear every trace of the session locally, then try the IdP portal logout. */
export async function signOut(): Promise<void> {
  clearStoredSession();
  clearStoredFlow();
  discoveryCache = null;
  await notifyPortalLogout();
}
