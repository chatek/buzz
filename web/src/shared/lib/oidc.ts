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
 *
 * FAILURES ARE NAMED (I-19 + I-29, measured 2026-09-27). The shipped module
 * emitted ONE sentence — "Could not reach the identity provider at …" — for a
 * timeout, a DNS failure, a TLS failure, a CORS/opaque refusal and an abort
 * alike, from a single `catch`, with no elapsed time. It also spent a network
 * round trip on discovery before it could build the authorization URL, against
 * a measured 9 s tail TTFB and a 10 s abort. Now:
 *   - every transport failure carries a `cause` (`timeout` vs `network`) plus
 *     the elapsed ms against the configured budget, in the message AND in the
 *     error's `detail`;
 *   - the discovery budget is 20 s per attempt and ONE retry is allowed on a
 *     transport failure, logged as it happens and counted in the message;
 *   - the login path uses the BAKED endpoints by default, so nothing is
 *     fetched before the redirect (discovery is the fallback, not the gate);
 *   - a failed attempt never writes or clears the discovery cache, so a bad
 *     minute cannot become a fetch storm.
 * The error `code`s are unchanged (`discovery_unreachable`, `discovery_failed`,
 * `discovery_malformed`); the CAUSE is what was missing and is what is added.
 */

import {
  AUTHELIA_LOGOUT_PATH,
  bakedDiscovery,
  buildAuthorizationUrl,
  discoveryUrl,
  type OidcConfig,
  type OidcEnv,
  pkceChallenge,
  randomUrlSafe,
  resolveDiscoveryMode,
  resolveDiscoveryTimeoutMs,
  resolveOidcConfig,
  resolveTokenTimeoutMs,
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
/**
 * Attempts per discovery request. 2 = the first transport failure gets ONE
 * bounded retry (a JSON GET is safe to repeat); a status answer is not
 * retried, and neither is the token POST (an authorization code is single use —
 * see `postTokenRequest`). The per-attempt budget is the env-overridable
 * `VITE_OIDC_DISCOVERY_TIMEOUT_MS` (default 20 s).
 */
const DISCOVERY_ATTEMPTS = 2;

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

/**
 * A typed failure with a stable machine-readable `code` plus a `detail` bag.
 *
 * `code` is the coarse state the app already had (`discovery_unreachable`,
 * `discovery_failed`, `discovery_malformed`, `token_endpoint_unreachable`, …).
 * `detail.cause` is the part the shipped module threw away: `timeout` vs
 * `network` vs `http_status` vs `not_json`, with the elapsed ms, the budget,
 * the status and a body snippet. A caller may show `message`; a human
 * diagnosing the human path wants `detail`.
 */
export class OidcError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OidcError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): never {
  throw new OidcError(code, message, detail);
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

/**
 * WHY a request did not produce a document. The `code` stays coarse on purpose
 * (`discovery_unreachable` covers every transport failure, as it always has);
 * the cause is what the shipped module threw away.
 */
export type RequestFailureCause = "timeout" | "network";

export type DiscoveryProgress = {
  phase: "start" | "retry" | "failed";
  /** 1-based attempt number the event belongs to. */
  attempt: number;
  attempts: number;
  timeoutMs: number;
  /** Wall-clock ms the attempt that produced this event took. */
  elapsedMs: number;
};

export type DiscoveryOptions = {
  force?: boolean;
  /** Per-attempt abort budget; defaults to `VITE_OIDC_DISCOVERY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Total attempts, 1 = no retry; defaults to 2 (one retry). */
  attempts?: number;
  /** Called at the start of every attempt and on a retry/give-up, for the UI. */
  onProgress?: (event: DiscoveryProgress) => void;
};

export type EndpointSource =
  | "baked"
  | "discovery"
  | "discovery-cache"
  | "provided";

/** What the app used to address the IdP on the last login attempt. */
export type EndpointResolution = {
  source: EndpointSource;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  at: number;
};

export type OidcLogEntry = {
  at: number;
  level: "info" | "warn";
  message: string;
};

const LOG_LIMIT = 50;
const logEntries: OidcLogEntry[] = [];

/** The recent `oidc.ts` decisions and failures, newest last (diagnostics). */
export function oidcLog(): readonly OidcLogEntry[] {
  return logEntries;
}

export function clearOidcLog(): void {
  logEntries.length = 0;
}

function log(level: OidcLogEntry["level"], message: string): void {
  logEntries.push({ at: Date.now(), level, message });
  if (logEntries.length > LOG_LIMIT) {
    logEntries.shift();
  }
  const line = `[oidc] ${message}`;
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

let discoveryCache: {
  key: string;
  fetchedAt: number;
  value: OidcDiscovery;
} | null = null;

let lastResolution: EndpointResolution | null = null;

/** Which endpoints the last login attempt used, and where they came from. */
export function lastEndpointResolution(): EndpointResolution | null {
  return lastResolution;
}

/** Drop the in-memory discovery document (sign-out; tests; drift fallback). */
export function clearDiscoveryCache(): void {
  discoveryCache = null;
}

/** The cached document when it is still inside the TTL, else null. */
function cachedDiscovery(config: OidcConfig): OidcDiscovery | null {
  const cached = discoveryCache;
  if (!cached || cached.key !== discoveryUrl(config)) {
    return null;
  }
  return Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS ? cached.value : null;
}

/* -------------------------------------------------- failure vocabulary (I-29) */

/** `AbortSignal.timeout` rejects with `TimeoutError` (and `AbortError` before
 * the spec settled); both mean "we hit OUR budget", not "the network refused". */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function describeSeconds(ms: number): string {
  if (ms < 1_000) {
    return `${ms} ms`;
  }
  return ms % 1_000 === 0 ? `${ms / 1_000} s` : `${(ms / 1_000).toFixed(1)} s`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error);
}

/** A browser cannot separate DNS from CORS from a refused TCP connection; the
 * online/offline signal is the one extra fact it DOES have. Say so honestly. */
function onlineNote(): string {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.onLine !== "boolean"
  ) {
    return "this browser does not report an online/offline state";
  }
  return navigator.onLine
    ? "this browser reports it is ONLINE, so suspect DNS, routing, TLS or the issuer's CORS policy for this origin"
    : "this browser reports it is OFFLINE";
}

function snippetOf(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function contentTypeOf(response: Response): string {
  try {
    return response.headers.get("content-type") ?? "";
  } catch {
    return "";
  }
}

/**
 * `AbortSignal.timeout` where it exists (Chrome 103+, Safari 16+), and an
 * equivalent AbortController timer where it does not — the abort budget is the
 * feature that bounds the wait, so it must not silently go missing.
 */
function budgetSignal(ms: number): AbortSignal {
  const native = (
    AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  ).timeout;
  if (typeof native === "function") {
    return native.call(AbortSignal, ms);
  }
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(
      new DOMException(`aborted after ${ms} ms`, "TimeoutError"),
    );
  }, ms);
  return controller.signal;
}

type DiscoveryAttempt =
  | { ok: true; document: OidcDiscovery; elapsedMs: number; status: number }
  | { ok: false; retryable: boolean; elapsedMs: number; error: OidcError };

async function attemptDiscoveryFetch(
  url: string,
  issuer: string,
  timeoutMs: number,
): Promise<DiscoveryAttempt> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      // A public document: no cookies, no credentials (deliberate — keep it).
      credentials: "omit",
      signal: budgetSignal(timeoutMs),
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const cause: RequestFailureCause = isAbortError(error)
      ? "timeout"
      : "network";
    const message =
      cause === "timeout"
        ? `The identity provider at ${issuer} did not answer within ${describeSeconds(
            timeoutMs,
          )} (the request was aborted after ${elapsedMs} ms). A slow or unreachable network path can do this; the request may still have been served. Nothing was stored.`
        : `The browser could not reach the identity provider at ${issuer}: the request failed after ${elapsedMs} ms with ${describeError(
            error,
          )}. A DNS failure, a refused connection and a cross-origin (CORS) refusal are indistinguishable to a browser; ${onlineNote()}. Nothing was stored.`;
    return {
      ok: false,
      // A transport failure is the only thing worth repeating here.
      retryable: true,
      elapsedMs,
      error: new OidcError("discovery_unreachable", message, {
        cause,
        elapsedMs,
        timeoutMs,
        url,
        issuer,
        error: describeError(error),
      }),
    };
  }

  const elapsedMs = Date.now() - startedAt;
  // Read the body as TEXT first, so a non-JSON body can be quoted back
  // (`response.json()` would consume it and lose the evidence).
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    const snippet = snippetOf(raw);
    return {
      ok: false,
      // A status is an ANSWER: repeating the request will not change it.
      retryable: false,
      elapsedMs,
      error: new OidcError(
        "discovery_failed",
        `The identity provider at ${issuer} answered the discovery request with HTTP ${response.status} after ${elapsedMs} ms${
          snippet ? `: ${snippet}` : " and an empty body"
        }. Nothing was stored.`,
        {
          cause: "http_status",
          status: response.status,
          elapsedMs,
          url,
          issuer,
          contentType: contentTypeOf(response),
          snippet,
        },
      ),
    };
  }

  let parsed: unknown = null;
  let parseError = "";
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    parseError = describeError(error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const contentType = contentTypeOf(response);
    return {
      ok: false,
      retryable: false,
      elapsedMs,
      error: new OidcError(
        "discovery_malformed",
        `The identity provider at ${issuer} answered HTTP ${response.status} after ${elapsedMs} ms, but the discovery body is not a JSON object${
          contentType ? ` (content-type: ${contentType})` : ""
        }${parseError ? ` [${parseError}]` : ""}${
          raw ? `: ${snippetOf(raw)}` : " and it is empty"
        }. Something other than the identity provider may be serving this path. Nothing was stored.`,
        {
          cause: "not_json",
          status: response.status,
          elapsedMs,
          url,
          issuer,
          contentType,
          snippet: snippetOf(raw),
          parseError,
        },
      ),
    };
  }

  const document = parsed as OidcDiscovery;
  if (
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string"
  ) {
    return {
      ok: false,
      retryable: false,
      elapsedMs,
      error: new OidcError(
        "discovery_malformed",
        "The identity provider discovery document is missing required endpoints.",
        {
          cause: "missing_endpoints",
          status: response.status,
          elapsedMs,
          url,
          issuer,
          snippet: snippetOf(raw),
        },
      ),
    };
  }
  return { ok: true, document, elapsedMs, status: response.status };
}

/**
 * Fetch and cache the issuer's discovery document (in memory, 10 minutes; a
 * full page load re-fetches). Cached in memory rather than storage because it
 * is cheap, public, and must never be trusted from a previous session.
 *
 * ONE retry on a transport failure, and the retry is visible: it is logged,
 * counted in the final message, and reported to `options.onProgress`. A failed
 * attempt NEVER writes or clears the cache, so an outage cannot turn a cached
 * document into a fetch storm.
 */
export async function fetchDiscovery(
  config: OidcConfig,
  options?: DiscoveryOptions,
): Promise<OidcDiscovery> {
  const url = discoveryUrl(config);
  if (!options?.force) {
    const cached = cachedDiscovery(config);
    if (cached) {
      log(
        "info",
        `discovery: in-memory cache hit for ${url} — no request made`,
      );
      return cached;
    }
  }
  const timeoutMs = options?.timeoutMs ?? resolveDiscoveryTimeoutMs(oidcEnv());
  const attempts = Math.max(1, options?.attempts ?? DISCOVERY_ATTEMPTS);
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options?.onProgress?.({
      phase: "start",
      attempt,
      attempts,
      timeoutMs,
      elapsedMs: 0,
    });
    log(
      "info",
      `discovery: attempt ${attempt}/${attempts} GET ${url} (abort after ${timeoutMs} ms)`,
    );
    const result = await attemptDiscoveryFetch(url, config.issuer, timeoutMs);
    if (result.ok) {
      discoveryCache = {
        key: url,
        fetchedAt: Date.now(),
        value: result.document,
      };
      log(
        "info",
        `discovery: HTTP ${result.status} in ${result.elapsedMs} ms → authorization_endpoint=${result.document.authorization_endpoint} token_endpoint=${result.document.token_endpoint}`,
      );
      return result.document;
    }
    const retrying = result.retryable && attempt < attempts;
    options?.onProgress?.({
      phase: retrying ? "retry" : "failed",
      attempt,
      attempts,
      timeoutMs,
      elapsedMs: result.elapsedMs,
    });
    log(
      "warn",
      `discovery: attempt ${attempt}/${attempts} failed (${result.error.code}) after ${result.elapsedMs} ms — ${
        retrying
          ? "retrying once (a JSON GET is safe to repeat)"
          : `giving up after ${Date.now() - startedAt} ms in total`
      }`,
    );
    if (!retrying) {
      throw result.error;
    }
  }
  // The loop either returns a document or throws; this keeps the types honest.
  return fail(
    "discovery_unreachable",
    `Discovery of ${url} produced no result.`,
  );
}

/**
 * The endpoints to use for a login, plus WHERE THEY CAME FROM.
 *
 * `baked` is the default: the issuer is known and its three paths are fixed,
 * so the login button performs NO network request before it redirects (I-19
 * put a 9 s tail TTFB in front of every login). `VITE_OIDC_DISCOVERY=always`
 * restores discovery-first, and a 404/405 from the token endpoint on the baked
 * path falls back to discovery (see `exchangeAtTokenEndpoint`).
 */
async function resolveEndpoints(
  config: OidcConfig,
  options?: {
    discovery?: OidcDiscovery;
    onProgress?: (event: DiscoveryProgress) => void;
  },
): Promise<{ discovery: OidcDiscovery; source: EndpointSource }> {
  if (options?.discovery) {
    recordResolution("provided", options.discovery, config);
    return { discovery: options.discovery, source: "provided" };
  }
  const cached = cachedDiscovery(config);
  if (resolveDiscoveryMode(oidcEnv()) === "baked") {
    const baked = bakedDiscovery(config);
    recordResolution("baked", baked, config);
    log(
      "info",
      `endpoints: using the BAKED endpoints for ${config.issuer} — no discovery round trip on the login path (set VITE_OIDC_DISCOVERY=always to fetch discovery first)`,
    );
    return { discovery: baked, source: "baked" };
  }
  const document = await fetchDiscovery(config, {
    onProgress: options?.onProgress,
  });
  const source: EndpointSource =
    cached && cached === document ? "discovery-cache" : "discovery";
  recordResolution(source, document, config);
  return { discovery: document, source };
}

function recordResolution(
  source: EndpointSource,
  discovery: OidcDiscovery,
  config: OidcConfig,
): void {
  lastResolution = {
    source,
    issuer: config.issuer,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
    at: Date.now(),
  };
}

/** The build-time env, read at CALL time so a test (or a late env) can set it. */
let envOverrides: OidcEnv | null = null;

/**
 * Replace the env `oidc.ts` reads (TEST/EMBEDDING ONLY — the app never calls
 * this; `null` restores `import.meta.env`). Exists so the baked-vs-discovery
 * choice and the timeout budget can be exercised without a rebuild.
 */
export function setOidcEnvOverride(env: OidcEnv | null): void {
  envOverrides = env;
}

function oidcEnv(): OidcEnv | undefined {
  if (envOverrides) {
    return envOverrides;
  }
  try {
    return (import.meta.env ?? undefined) as OidcEnv | undefined;
  } catch {
    return undefined;
  }
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
    /** Progress of the discovery fetch, when one happens (it usually does not). */
    onProgress?: (event: DiscoveryProgress) => void;
  },
): Promise<AuthorizationRequest> {
  const resolved = await resolveEndpoints(config, {
    discovery: options?.discovery,
    onProgress: options?.onProgress,
  });
  const discovery = resolved.discovery;
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
  timeoutMs: number = resolveTokenTimeoutMs(oidcEnv()),
): Promise<OidcTokens> {
  const startedAt = Date.now();
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
      signal: budgetSignal(timeoutMs),
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    // NO RETRY HERE, deliberately: an authorization code is single use, so an
    // automatic repeat can burn the code and turn a slow network into
    // `invalid_grant`. Discovery (a GET) retries; the exchange does not.
    if (isAbortError(error)) {
      return fail(
        "token_endpoint_unreachable",
        `The identity provider token endpoint did not answer within ${describeSeconds(
          timeoutMs,
        )} (the request was aborted after ${elapsedMs} ms; the code was NOT redeemed here). Start the sign-in again from the button. Nothing was stored.`,
        { cause: "timeout", elapsedMs, timeoutMs, endpoint: tokenEndpoint },
      );
    }
    return fail(
      "token_endpoint_unreachable",
      `The browser could not reach the identity provider token endpoint: the request failed after ${elapsedMs} ms with ${describeError(
        error,
      )}. A DNS failure, a refused connection and a cross-origin (CORS) refusal are indistinguishable to a browser; ${onlineNote()} — the issuer must allow this origin for /api/oidc/token. Nothing was stored.`,
      {
        cause: "network",
        elapsedMs,
        timeoutMs,
        endpoint: tokenEndpoint,
        error: describeError(error),
      },
    );
  }
  const elapsedMs = Date.now() - startedAt;
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
    return fail(code, `Sign-in was refused: ${detail}.`, {
      cause: "http_status",
      status: response.status,
      elapsedMs,
      endpoint: tokenEndpoint,
    });
  }
  return parseTokenResponse(payload);
}

/** A 404/405 from the token endpoint is the signature of a stale BAKED path. */
function isEndpointDrift(cause: unknown): boolean {
  return (
    cause instanceof OidcError &&
    (cause.code === "http_404" || cause.code === "http_405")
  );
}

/**
 * POST a token request to an endpoint, with the DISCOVERY FALLBACK: when the
 * endpoint came from the baked configuration and the issuer answers 404/405
 * (i.e. the assumption has drifted), re-resolve the endpoints from the
 * discovery document once and repeat. Which one ran is logged and recorded in
 * `lastEndpointResolution()`.
 */
async function exchangeAtTokenEndpoint(params: {
  config: OidcConfig;
  discovery: OidcDiscovery;
  source: EndpointSource;
  body: URLSearchParams;
}): Promise<OidcTokens> {
  const timeoutMs = resolveTokenTimeoutMs(oidcEnv());
  try {
    return await postTokenRequest(
      params.discovery.token_endpoint,
      params.body,
      timeoutMs,
    );
  } catch (cause) {
    if (params.source !== "baked" || !isEndpointDrift(cause)) {
      throw cause;
    }
    log(
      "warn",
      `token: the BAKED endpoint ${params.discovery.token_endpoint} answered ${
        (cause as OidcError).code
      } — falling back to discovery and retrying once`,
    );
    const document = await fetchDiscovery(params.config, { force: true });
    recordResolution("discovery", document, params.config);
    log(
      "info",
      `token: retrying against the DISCOVERED endpoint ${document.token_endpoint}`,
    );
    return postTokenRequest(document.token_endpoint, params.body, timeoutMs);
  }
}

/** Redeem an authorization code. Public client: no secret, PKCE verifier only. */
export async function exchangeAuthorizationCode(params: {
  config: OidcConfig;
  discovery: OidcDiscovery;
  code: string;
  codeVerifier: string;
  /** Where `discovery` came from; `baked` unlocks the drift fallback. */
  source?: EndpointSource;
}): Promise<OidcTokens> {
  return exchangeAtTokenEndpoint({
    config: params.config,
    discovery: params.discovery,
    source: params.source ?? "provided",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.config.redirectUri,
      client_id: params.config.clientId,
      code_verifier: params.codeVerifier,
    }),
  });
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
  const resolved = await resolveEndpoints(config);
  const tokens = await exchangeAtTokenEndpoint({
    config,
    discovery: resolved.discovery,
    source: resolved.source,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.tokens.refreshToken,
      client_id: config.clientId,
    }),
  });
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

  const resolved = await resolveEndpoints(config);
  const tokens = await exchangeAuthorizationCode({
    config,
    discovery: resolved.discovery,
    source: resolved.source,
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
