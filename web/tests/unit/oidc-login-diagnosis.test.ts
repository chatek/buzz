/**
 * WHY THE LOGIN FAILED, AND HOW LONG IT WAITED — the failure vocabulary, the
 * abort budget, the one bounded retry, and the discovery skip, as
 * FAILING-BY-DESIGN controls.
 *
 * THE DEFECT (I-19 + I-29, measured 2026-09-27 in the SERVED bundle
 * `assets/index-EJZyMjRB.js`): every transport failure of the discovery fetch
 * ran through ONE `catch` that emitted ONE sentence —
 * `discovery_unreachable` / "Could not reach the identity provider at …" —
 * with no cause and no elapsed time. A 10 s timeout (`DISCOVERY_TIMEOUT_MS =
 * 1e4`), a DNS failure, a TLS failure, a CORS refusal and an abort were
 * therefore the same report, and the same code spent a network round trip on
 * discovery BEFORE it could build the authorization URL, against a measured
 * 9.0 s tail TTFB. The operator's "Could not reach the identity provider"
 * could not be diagnosed without probes.
 *
 * WHAT THIS FILE PINS, in both directions:
 *   LEG 1 — the four causes produce four DISTINCT sentences and four distinct
 *     `detail.cause` values, while the two coarse `code`s the app already had
 *     are preserved (`discovery_unreachable` for every transport failure,
 *     `discovery_failed` for a status answer). The timeout message carries the
 *     budget AND the elapsed ms; the network message carries the underlying
 *     error and the one extra fact a browser has (online/offline).
 *   LEG 2 (the negative leg) — the SAME four stubs, against the shipped
 *     `catch`, produce fewer distinct sentences and no cause. MEASURED
 *     out of band by swapping the pre-fix file in
 *     (`git show HEAD:web/src/shared/lib/oidc.ts`, sha256 d265d44e…, with ONE
 *     issuer for all four causes): 3 distinct messages of 4, `detail: null`
 *     everywhere, and the timeout/network pair BYTE-IDENTICAL
 *     ("Could not reach the identity provider at https://auth.vclawhub.com.")
 *     after a 10 011 ms wait — while the caller had asked for 400 ms, because
 *     the shipped budget was a hardcoded constant. The same script against the
 *     fixed file gives 4 distinct messages and honours the 400 ms budget
 *     (401 ms). A copy of the shipped sentence is asserted below so the fix
 *     cannot silently regress to it.
 *
 * ALSO PINNED, because they are the reasons the fix is shaped this way:
 *   - the login path makes NO request before it redirects (baked endpoints);
 *   - `VITE_OIDC_DISCOVERY=always` really does fetch and really does use the
 *     discovered endpoint (`lastEndpointResolution()` says which ran);
 *   - a 404 from the BAKED token endpoint falls back to discovery ONCE;
 *   - the token POST is NOT retried (an authorization code is single use);
 *   - a failed attempt neither writes nor clears the 10-minute cache.
 *
 * RUNNER. `bun test tests/unit/oidc-login-diagnosis.test.ts` (the web package's
 * unit runner is `pnpm dlx bun@1.4.0 test tests/unit/`). NOTE: `tsc --noEmit`
 * covers `src` only (`tsconfig.json` "include": ["src"]), so this file is
 * type-STRIPPED by bun, not type-checked by the project.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearDiscoveryCache,
  clearOidcLog,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  fetchDiscovery,
  lastEndpointResolution,
  OidcError,
  oidcLog,
  setOidcEnvOverride,
} from "../../src/shared/lib/oidc";
import {
  bakedDiscovery,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_TOKEN_TIMEOUT_MS,
  discoveryUrl,
  resolveDiscoveryMode,
  resolveDiscoveryTimeoutMs,
  resolveOidcConfig,
  resolveTokenTimeoutMs,
  resolveTimeoutMs,
} from "../../src/shared/lib/oidc-config";

const ISSUER = "https://auth.vclawhub.com";
const APP_ORIGIN = "https://agents.vclawhub.com";
const CONFIG = resolveOidcConfig(undefined, APP_ORIGIN);
const DISCOVERY_URL = discoveryUrl(CONFIG);

/** The exact sentence the shipped `catch` emitted, for every cause alike. */
const SHIPPED_SENTENCE = `Could not reach the identity provider at ${ISSUER}.`;

/** A small, REAL budget: the tests must not wait 20 s to prove a timeout. */
const TEST_BUDGET_MS = 80;

type Call = { url: string; init: RequestInit | undefined };

let calls: Call[] = [];
let impl: (url: string, init?: RequestInit) => Promise<Response>;
let restoreFetch: () => void;
let consoleLines: string[] = [];
const originalInfo = console.info;
const originalWarn = console.warn;

function installFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

/**
 * An endpoint that never answers. It HONOURS the abort signal the module
 * passes, and FAILS LOUDLY (instead of hanging the suite) when no signal was
 * passed — so an implementation that drops the abort budget cannot pass by
 * accident.
 */
function hangingEndpoint(): (
  url: string,
  init?: RequestInit,
) => Promise<Response> {
  return (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () =>
        reject(new DOMException("The operation was aborted.", "TimeoutError"));
      if (!signal) {
        setTimeout(
          () =>
            reject(
              new Error(
                "no AbortSignal was passed to fetch — the abort budget is not wired",
              ),
            ),
          3_000,
        );
        return;
      }
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  };
}

function respondingWith(
  response: () => Response,
): (url: string, init?: RequestInit) => Promise<Response> {
  return () => Promise.resolve(response());
}

function failingWith(
  error: () => Error,
): (url: string, init?: RequestInit) => Promise<Response> {
  return () => Promise.reject(error());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(
  body: string,
  status = 200,
  contentType = "text/html",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

const DISCOVERY_DOCUMENT = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/oidc/authorization`,
  token_endpoint: `${ISSUER}/api/oidc/token`,
  jwks_uri: `${ISSUER}/jwks.json`,
  code_challenge_methods_supported: ["S256"],
};

async function rejection(run: () => Promise<unknown>): Promise<OidcError> {
  try {
    await run();
  } catch (cause) {
    if (!(cause instanceof OidcError)) {
      throw cause;
    }
    return cause;
  }
  throw new Error("expected a rejection, but the call resolved");
}

function loggedMessages(): string {
  return oidcLog()
    .map((entry) => entry.message)
    .join("\n");
}

beforeEach(() => {
  calls = [];
  consoleLines = [];
  console.info = ((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  }) as typeof console.info;
  console.warn = ((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  }) as typeof console.warn;
  clearOidcLog();
  clearDiscoveryCache();
  setOidcEnvOverride(null);
  installFetch();
});

afterEach(() => {
  restoreFetch();
  console.info = originalInfo;
  console.warn = originalWarn;
  setOidcEnvOverride(null);
  clearDiscoveryCache();
  clearOidcLog();
});

/* ------------------------------------------------------------------ LEG 1 */

describe("LEG 1 — a timeout is not a network failure is not a status", () => {
  test("past the budget: CLASSIFIED AS A TIMEOUT, with the budget and the elapsed ms", async () => {
    impl = hangingEndpoint();
    const startedAt = Date.now();
    const error = await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: TEST_BUDGET_MS, attempts: 2 }),
    );
    const elapsed = Date.now() - startedAt;

    // The coarse code the app already had, unchanged.
    expect(error.code).toBe("discovery_unreachable");
    // …plus the cause it threw away.
    expect(error.detail.cause).toBe("timeout");
    expect(error.detail.timeoutMs).toBe(TEST_BUDGET_MS);
    expect(typeof error.detail.elapsedMs).toBe("number");
    expect(error.message).toContain(
      `did not answer within ${TEST_BUDGET_MS} ms`,
    );
    expect(error.message).toContain("aborted after");
    expect(error.message).not.toContain(SHIPPED_SENTENCE);
    // Two attempts, both aborted by the budget: the elapsed time proves it.
    expect(calls.length).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(2 * TEST_BUDGET_MS - 20);
  });

  test("the retry is VISIBLE, not silent (log + the count in the message)", async () => {
    impl = hangingEndpoint();
    await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: TEST_BUDGET_MS, attempts: 2 }),
    );
    const messages = loggedMessages();
    expect(messages).toContain("attempt 1/2");
    expect(messages).toContain("retrying once");
    expect(messages).toContain("giving up after");
    expect(consoleLines.join("\n")).toContain("[oidc]");
    // `attempts` is settable to 1, which must mean exactly one request.
    calls = [];
    clearOidcLog();
    await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: TEST_BUDGET_MS, attempts: 1 }),
    );
    expect(calls.length).toBe(1);
    expect(loggedMessages()).not.toContain("retrying once");
  });

  test("a network/DNS failure is CLASSIFIED AS A NETWORK FAILURE, with the cause quoted", async () => {
    impl = failingWith(() => new TypeError("Failed to fetch"));
    const error = await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: 500, attempts: 2 }),
    );

    expect(error.code).toBe("discovery_unreachable");
    expect(error.detail.cause).toBe("network");
    expect(error.message).toContain("could not reach the identity provider");
    expect(error.message).toContain("TypeError: Failed to fetch");
    // Honest about the limit of a browser: DNS, TCP and CORS are one signal.
    expect(error.message).toContain("indistinguishable to a browser");
    expect(error.message).not.toContain("did not answer within");
    expect(calls.length).toBe(2);
  });

  test("a 500 is CLASSIFIED AS A STATUS FAILURE, with the status and a body snippet, and is NOT retried", async () => {
    impl = respondingWith(() =>
      textResponse("upstream boom", 500, "text/plain"),
    );
    const error = await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: 500, attempts: 2 }),
    );

    expect(error.code).toBe("discovery_failed");
    expect(error.detail.cause).toBe("http_status");
    expect(error.detail.status).toBe(500);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain("upstream boom");
    // A status is an ANSWER: repeating it changes nothing.
    expect(calls.length).toBe(1);
  });

  test("a 200 that is not JSON is CLASSIFIED AS MALFORMED, and says who is serving the path", async () => {
    impl = respondingWith(() =>
      textResponse("<!doctype html><title>idp</title>", 200, "text/html"),
    );
    const error = await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: 500 }),
    );

    expect(error.code).toBe("discovery_malformed");
    expect(error.detail.cause).toBe("not_json");
    expect(error.message).toContain("not a JSON object");
    expect(error.message).toContain("text/html");
    expect(error.message).toContain("doctype html");
    expect(calls.length).toBe(1);
  });

  test("a 200 JSON document without the endpoints is CLASSIFIED AS MALFORMED", async () => {
    impl = respondingWith(() =>
      jsonResponse({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` }),
    );
    const error = await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: 500 }),
    );
    expect(error.code).toBe("discovery_malformed");
    expect(error.detail.cause).toBe("missing_endpoints");
    expect(error.message).toContain("missing required endpoints");
  });

  test("the SAME endpoint UNDER budget succeeds (the negative of the timeout leg)", async () => {
    impl = (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(jsonResponse(DISCOVERY_DOCUMENT)),
          20,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(
            new DOMException("The operation was aborted.", "TimeoutError"),
          );
        });
      });
    const startedAt = Date.now();
    const document = await fetchDiscovery(CONFIG, {
      timeoutMs: TEST_BUDGET_MS,
    });
    expect(document.token_endpoint).toBe(DISCOVERY_DOCUMENT.token_endpoint);
    expect(Date.now() - startedAt).toBeLessThan(TEST_BUDGET_MS * 4);
    expect(calls.length).toBe(1);
  });
});

describe("LEG 2 (control) — the four causes are FOUR sentences, and none is the shipped one", () => {
  test("four distinct messages, one per cause", async () => {
    const messages: string[] = [];
    impl = hangingEndpoint();
    messages.push(
      (
        await rejection(() =>
          fetchDiscovery(CONFIG, { timeoutMs: TEST_BUDGET_MS, attempts: 1 }),
        )
      ).message,
    );
    clearDiscoveryCache();
    impl = failingWith(() => new TypeError("Failed to fetch"));
    messages.push(
      (await rejection(() => fetchDiscovery(CONFIG, { timeoutMs: 500 })))
        .message,
    );
    clearDiscoveryCache();
    impl = respondingWith(() => textResponse("boom", 503, "text/plain"));
    messages.push(
      (await rejection(() => fetchDiscovery(CONFIG, { timeoutMs: 500 })))
        .message,
    );
    clearDiscoveryCache();
    impl = respondingWith(() => textResponse("<html/>", 200));
    messages.push(
      (await rejection(() => fetchDiscovery(CONFIG, { timeoutMs: 500 })))
        .message,
    );

    expect(new Set(messages).size).toBe(4);
    for (const message of messages) {
      expect(message).not.toBe(SHIPPED_SENTENCE);
      expect(
        message.startsWith("Could not reach the identity provider at"),
      ).toBe(false);
    }
    expect(messages[0]).toContain("did not answer within");
    expect(messages[1]).toContain("could not reach the identity provider");
    expect(messages[2]).toContain("HTTP 503");
    expect(messages[3]).toContain("not a JSON object");
  });
});

describe("THE CACHE is not collateral damage", () => {
  test("a cached document short-circuits the network, and a FAILED attempt does not clear it", async () => {
    impl = respondingWith(() => jsonResponse(DISCOVERY_DOCUMENT));
    await fetchDiscovery(CONFIG);
    expect(calls.length).toBe(1);

    // A later outage is invisible: the cached document is used, no request.
    impl = failingWith(() => new TypeError("Failed to fetch"));
    const cached = await fetchDiscovery(CONFIG);
    expect(cached.token_endpoint).toBe(DISCOVERY_DOCUMENT.token_endpoint);
    expect(calls.length).toBe(1);

    // A cold failure must not poison the next attempt either.
    clearDiscoveryCache();
    await rejection(() =>
      fetchDiscovery(CONFIG, { timeoutMs: TEST_BUDGET_MS, attempts: 1 }),
    );
    impl = respondingWith(() => jsonResponse(DISCOVERY_DOCUMENT));
    const recovered = await fetchDiscovery(CONFIG, { timeoutMs: 500 });
    expect(recovered.authorization_endpoint).toBe(
      DISCOVERY_DOCUMENT.authorization_endpoint,
    );
  });
});

/* ------------------------------------------------- the login critical path */

describe("THE LOGIN PATH makes no request before it redirects (discovery is the fallback)", () => {
  test("baked by default: a dead network still produces the authorization URL", async () => {
    impl = failingWith(() => new TypeError("Failed to fetch"));
    const request = await createAuthorizationRequest(CONFIG, {
      returnTo: "/repos",
    });
    const url = new URL(request.url);

    expect(calls.length).toBe(0);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${ISSUER}/api/oidc/authorization`,
    );
    expect(url.searchParams.get("client_id")).toBe("buzz-web");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/auth/callback`,
    );
    expect(url.searchParams.get("state")).toBe(request.flow.state);
    expect(lastEndpointResolution()?.source).toBe("baked");
    expect(loggedMessages()).toContain("BAKED");
    expect(
      JSON.parse(JSON.stringify(request.flow)).codeVerifier.length,
    ).toBeGreaterThan(0);
  });

  test("VITE_OIDC_DISCOVERY=always: discovery really runs and its endpoint really wins", async () => {
    setOidcEnvOverride({ VITE_OIDC_DISCOVERY: "always" });
    impl = respondingWith(() =>
      jsonResponse({
        ...DISCOVERY_DOCUMENT,
        authorization_endpoint:
          "https://idp-alt.example/api/oidc/authorization",
      }),
    );
    const request = await createAuthorizationRequest(CONFIG, {
      returnTo: "/repos",
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DISCOVERY_URL);
    expect(
      request.url.startsWith("https://idp-alt.example/api/oidc/authorization?"),
    ).toBe(true);
    expect(lastEndpointResolution()?.source).toBe("discovery");
    expect(lastEndpointResolution()?.authorizationEndpoint).toBe(
      "https://idp-alt.example/api/oidc/authorization",
    );
  });

  test("the progress callback fires on every attempt, so a retry can be shown", async () => {
    setOidcEnvOverride({
      VITE_OIDC_DISCOVERY: "always",
      VITE_OIDC_DISCOVERY_TIMEOUT_MS: "1000",
    });
    impl = hangingEndpoint();
    const phases: string[] = [];
    await rejection(() =>
      createAuthorizationRequest(CONFIG, {
        returnTo: "/repos",
        onProgress: (event) =>
          phases.push(`${event.phase}:${event.attempt}/${event.attempts}`),
      }),
    );
    expect(phases).toEqual([
      "start:1/2",
      "retry:1/2",
      "start:2/2",
      "failed:2/2",
    ]);
  });
});

describe("THE TOKEN LEG classifies too, and does not burn a single-use code", () => {
  test("a token endpoint that never answers is a TIMEOUT, retried ZERO times", async () => {
    setOidcEnvOverride({ VITE_OIDC_TOKEN_TIMEOUT_MS: "1000" });
    impl = hangingEndpoint();
    const error = await rejection(() =>
      exchangeAuthorizationCode({
        config: CONFIG,
        discovery: bakedDiscovery(CONFIG),
        source: "baked",
        code: "code-1",
        codeVerifier: "verifier-1",
      }),
    );
    expect(error.code).toBe("token_endpoint_unreachable");
    expect(error.detail.cause).toBe("timeout");
    expect(error.message).toContain("did not answer within 1 s");
    expect(calls.length).toBe(1);
  });

  test("a 404 on the BAKED endpoint falls back to DISCOVERY once, and says so", async () => {
    const fixedTokenEndpoint = `${ISSUER}/api/oidc/fixed-token`;
    impl = (url) => {
      if (url === DISCOVERY_URL) {
        return Promise.resolve(
          jsonResponse({
            ...DISCOVERY_DOCUMENT,
            token_endpoint: fixedTokenEndpoint,
          }),
        );
      }
      if (url === fixedTokenEndpoint) {
        return Promise.resolve(
          jsonResponse({
            access_token: "at-2",
            token_type: "Bearer",
            expires_in: 300,
            id_token: "h.p.s",
          }),
        );
      }
      return Promise.resolve(textResponse("", 404, "text/plain"));
    };
    const tokens = await exchangeAuthorizationCode({
      config: CONFIG,
      discovery: bakedDiscovery(CONFIG),
      source: "baked",
      code: "code-1",
      codeVerifier: "verifier-1",
    });
    expect(tokens.accessToken).toBe("at-2");
    expect(calls.map((call) => call.url)).toEqual([
      `${ISSUER}/api/oidc/token`,
      DISCOVERY_URL,
      fixedTokenEndpoint,
    ]);
    expect(loggedMessages()).toContain("falling back to discovery");
    expect(lastEndpointResolution()?.source).toBe("discovery");
  });
});

/* --------------------------------------------------------------- the numbers */

describe("THE BUDGET is a spec, and the env can move it", () => {
  test("the discovery budget is well clear of the measured tail, not a hair above it", () => {
    // MEASURED 2026-09-27, 50 consecutive sequential GETs of the live
    // discovery URL from this host (curl, TTFB): min 0.71 s, median 1.61 s,
    // p90 3.73 s, p95 4.44 s, max 8.41 s; 3 of 50 over 5 s. The dossier's
    // 9.0 s probe is the same long tail. Against a shipped abort of 10 s the
    // tail CROSSES the budget; 20 s is ~2.4x the observed max.
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(20_000);
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_TOKEN_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  test("the env overrides are parsed and CLAMPED", () => {
    expect(resolveDiscoveryTimeoutMs(undefined)).toBe(
      DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    expect(
      resolveDiscoveryTimeoutMs({ VITE_OIDC_DISCOVERY_TIMEOUT_MS: "45000" }),
    ).toBe(45_000);
    // A typo must not disable the abort, and must not make it absurd.
    expect(
      resolveDiscoveryTimeoutMs({ VITE_OIDC_DISCOVERY_TIMEOUT_MS: "1" }),
    ).toBe(1_000);
    expect(
      resolveDiscoveryTimeoutMs({ VITE_OIDC_DISCOVERY_TIMEOUT_MS: "9999999" }),
    ).toBe(120_000);
    expect(
      resolveDiscoveryTimeoutMs({ VITE_OIDC_DISCOVERY_TIMEOUT_MS: "soon" }),
    ).toBe(20_000);
    expect(resolveTokenTimeoutMs({ VITE_OIDC_TOKEN_TIMEOUT_MS: "30000" })).toBe(
      30_000,
    );
    expect(resolveTimeoutMs(undefined, 7)).toBe(7);
  });

  test("discovery is off unless it is asked for", () => {
    expect(resolveDiscoveryMode(undefined)).toBe("baked");
    expect(resolveDiscoveryMode({})).toBe("baked");
    expect(resolveDiscoveryMode({ VITE_OIDC_DISCOVERY: "baked" })).toBe(
      "baked",
    );
    expect(resolveDiscoveryMode({ VITE_OIDC_DISCOVERY: "yes-please" })).toBe(
      "baked",
    );
    expect(resolveDiscoveryMode({ VITE_OIDC_DISCOVERY: "always" })).toBe(
      "always",
    );
    expect(resolveDiscoveryMode({ VITE_OIDC_DISCOVERY: " ALWAYS " })).toBe(
      "always",
    );
  });

  test("the baked endpoints are the three measured Authelia paths", () => {
    const baked = bakedDiscovery(CONFIG);
    expect(baked.authorization_endpoint).toBe(
      `${ISSUER}/api/oidc/authorization`,
    );
    expect(baked.token_endpoint).toBe(`${ISSUER}/api/oidc/token`);
    expect(baked.jwks_uri).toBe(`${ISSUER}/jwks.json`);
    expect(baked.code_challenge_methods_supported).toEqual(["S256"]);
    // The issuer keeps working with a trailing slash, like `resolveOidcConfig`.
    expect(
      bakedDiscovery({ ...CONFIG, issuer: `${ISSUER}/` }).token_endpoint,
    ).toBe(`${ISSUER}/api/oidc/token`);
  });
});
