import { expect, test } from "@playwright/test";

/**
 * OIDC sign-in proofs for the vclaw IDP (Authorization Code + PKCE).
 *
 * No live IdP is contacted: discovery and the token endpoint are faked, which
 * is exactly what a real run adds (a registered `buzz-web` client and the
 * CORS switch on /api/oidc/token). What is proven here is the client:
 * the redirect, the PKCE binding, fail-closed `state` handling, the exchange,
 * the stored session, the displayed identity, and sign-out.
 */

const ISSUER = "https://auth.vclawhub.com";

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/oidc/authorization`,
  token_endpoint: `${ISSUER}/api/oidc/token`,
  jwks_uri: `${ISSUER}/jwks.json`,
  code_challenge_methods_supported: ["S256"],
};

function fakeIdToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.not-a-real-signature`;
}

function flowRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    state: "test-state",
    nonce: "test-nonce",
    codeVerifier: "test-code-verifier",
    redirectUri: "http://127.0.0.1:4173/auth/callback",
    issuer: ISSUER,
    clientId: "buzz-web",
    returnTo: null,
    startedAt: Date.now(),
    ...overrides,
  };
}

test("login route issues a 302 to the vclaw IdP with PKCE S256", async ({
  page,
}) => {
  const response = await page.request.get("/login", { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const location = response.headers().location ?? "";
  const url = new URL(location);
  expect(`${url.origin}${url.pathname}`).toBe(
    `${ISSUER}/api/oidc/authorization`,
  );
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe("buzz-web");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  expect(url.searchParams.get("state")).toMatch(/^[\w-]{40,}$/);
  expect(url.searchParams.get("nonce")).toMatch(/^[\w-]{40,}$/);
  expect(url.searchParams.get("scope")).toBe("openid profile email groups");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:4173/auth/callback",
  );
});

test("sign-in button starts the PKCE flow and stores the verifier", async ({
  page,
}) => {
  let authorizeUrl: URL | null = null;

  await page.route(`${ISSUER}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/.well-known/openid-configuration") {
      await route.fulfill({ json: discovery });
      return;
    }
    if (url.pathname === "/api/oidc/authorization") {
      authorizeUrl = url;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>idp</title>",
      });
      return;
    }
    await route.fulfill({ status: 404, body: "unexpected" });
  });

  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with vclaw" }).click();
  await expect.poll(() => authorizeUrl !== null).toBe(true);

  // sessionStorage is per tab, so returning to the app origin exposes what the
  // client stored before it navigated away.
  await page.goto("/");
  const flow = JSON.parse(
    (await page.evaluate(() =>
      window.sessionStorage.getItem("buzz-oidc-flow"),
    )) ?? "null",
  ) as {
    state: string;
    nonce: string;
    codeVerifier: string;
  } | null;
  expect(flow).not.toBeNull();
  const request = authorizeUrl as URL;
  expect(flow?.state).toBe(request.searchParams.get("state"));
  expect(flow?.nonce).toBe(request.searchParams.get("nonce"));

  // RFC 7636: challenge = BASE64URL(SHA-256(ASCII(verifier))).
  const recomputed = await page.evaluate(async (verifier: string) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }, flow?.codeVerifier ?? "");
  expect(recomputed).toBe(request.searchParams.get("code_challenge"));
});

test("auth callback fails closed on a mismatched state", async ({ page }) => {
  const idpRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(ISSUER)) {
      idpRequests.push(request.url());
    }
  });

  await page.addInitScript(
    (flow) => {
      window.sessionStorage.setItem("buzz-oidc-flow", JSON.stringify(flow));
    },
    flowRecord({ state: "expected-state" }),
  );

  await page.goto("/auth/callback?code=forged-code&state=wrong-state");

  await expect(
    page.getByRole("heading", { name: "Sign-in failed" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("state mismatch");
  // Nothing was sent to the IdP, and the single-use flow is gone.
  expect(idpRequests).toEqual([]);
  expect(
    await page.evaluate(() => window.sessionStorage.getItem("buzz-oidc-flow")),
  ).toBeNull();
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("buzz-oidc-session"),
    ),
  ).toBeNull();
});

test("auth callback exchanges the code, shows the identity, then signs out", async ({
  page,
}) => {
  const idToken = fakeIdToken({
    iss: ISSUER,
    aud: "buzz-web",
    sub: "user-1",
    email: "alice@vclawhub.com",
    preferred_username: "alice",
    name: "Alice",
    groups: ["staff"],
    nonce: "test-nonce",
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
  });
  let exchangeBody: string | null = null;

  await page.route(`${ISSUER}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/.well-known/openid-configuration") {
      await route.fulfill({ json: discovery });
      return;
    }
    if (url.pathname === "/api/oidc/token") {
      exchangeBody = route.request().postData();
      await route.fulfill({
        json: {
          access_token: "access-token-1",
          id_token: idToken,
          refresh_token: "refresh-token-1",
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid profile email groups",
        },
      });
      return;
    }
    if (url.pathname === "/api/logout") {
      await route.fulfill({ status: 200, body: "" });
      return;
    }
    await route.fulfill({ status: 404, body: "unexpected" });
  });

  await page.addInitScript((flow) => {
    window.sessionStorage.setItem("buzz-oidc-flow", JSON.stringify(flow));
  }, flowRecord());

  await page.goto("/auth/callback?code=good-code&state=test-state");

  // Lands back on the app and names the human in the header.
  await expect(page.getByText("alice@vclawhub.com")).toBeVisible();

  const body = exchangeBody ?? "";
  expect(body).toContain("grant_type=authorization_code");
  expect(body).toContain("code=good-code");
  expect(body).toContain("code_verifier=test-code-verifier");
  expect(body).toContain("client_id=buzz-web");
  expect(body).toContain(
    encodeURIComponent("http://127.0.0.1:4173/auth/callback"),
  );
  expect(body).not.toContain("client_secret");

  const session = JSON.parse(
    (await page.evaluate(() =>
      window.sessionStorage.getItem("buzz-oidc-session"),
    )) ?? "null",
  ) as { tokens: { accessToken: string } } | null;
  expect(session?.tokens.accessToken).toBe("access-token-1");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("link", { name: /Sign in with vclaw/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("buzz-oidc-session"),
    ),
  ).toBeNull();
});

/**
 * The open-redirect proof, in a REAL BROWSER: the query string an attacker
 * controls must not survive into the stored PKCE flow record.
 *
 * `?returnTo=` reaches `auth.callback.tsx` -> `window.location.replace(...)`
 * through `buzz-oidc-flow`, so the value the flow record holds is the value the
 * browser would have navigated to after a real sign-in. The unit test
 * `tests/unit/open-redirect-return-to.test.ts` asserts the classifier and the
 * call site; this asserts the same property through the router, the real
 * `validateSearch`, and real sessionStorage — the path that made the defect
 * live. No IdP is contacted: discovery and the redirect are stubbed.
 */
test("a hostile ?returnTo= is refused before it is stored", async ({
  page,
}) => {
  await page.route(`${ISSUER}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/.well-known/openid-configuration") {
      await route.fulfill({ json: discovery });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>idp</title>",
    });
  });

  /** Start a sign-in from `?returnTo=<value>` and report what was stored. */
  const storedReturnToFor = async (value: string) => {
    await page.goto(`/login?returnTo=${encodeURIComponent(value)}`);
    await page.getByRole("button", { name: "Continue with vclaw" }).click();
    // The click leaves for the stubbed authorization endpoint…
    await page.waitForURL(`${ISSUER}/**`, { timeout: 10_000 });
    // …and sessionStorage is per origin, so come back to read what the click
    // wrote before the browser left.
    await page.goto("/");
    const flow = JSON.parse(
      (await page.evaluate(() =>
        window.sessionStorage.getItem("buzz-oidc-flow"),
      )) ?? "null",
    ) as { returnTo?: string } | null;
    return flow?.returnTo;
  };

  // Refused, although an unclassified value would resolve off origin.
  expect(await storedReturnToFor("https://evil.example")).toBe("/");
  expect(await storedReturnToFor("//evil.example")).toBe("/");
  expect(await storedReturnToFor("/\\evil.example")).toBe("/");

  // …and the CONTROL that makes the refusals mean something: an ordinary path
  // on this origin is kept, so the test is not passing because nothing is stored.
  expect(await storedReturnToFor("/repos")).toBe("/repos");
});
