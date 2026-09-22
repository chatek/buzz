/**
 * THE POST-SIGN-IN OPEN REDIRECT — a `?returnTo=` must be a same-origin
 * absolute path or nothing, as a FAILING-BY-DESIGN control.
 *
 * THE DEFECT. Found 2026-09-22, MEASURED against the served bundle
 * `/assets/index-SRXM6A06.js` (sha256
 * `cfb0dfe5f7132ec1fe8f6a3d114d660e29c194ed0bd2d2e6ad19e05fb74d4521`, byte
 * identical to the deployed file; the live page still serves that name):
 * `app/routes/login.tsx` read `?returnTo=` and passed it on, `shared/lib/oidc.ts`
 * persisted it in the `buzz-oidc-flow` sessionStorage record, and
 * `app/routes/auth.callback.tsx` ran `window.location.replace(returnTo)`. So
 * `https://agents.vclawhub.com/login?returnTo=https://evil.example` finished a
 * REAL sign-in on the attacker's page. Nothing asserted it, so nothing stopped
 * the next edit from restoring it — hence this file.
 *
 * IT ASSERTS THE PROPERTY IN BOTH DIRECTIONS:
 *   LEG 1 — every hostile vector is refused by the one classifier
 *     (`shared/lib/return-to.ts`) and the value that reaches the sink still
 *     resolves to the app origin.
 *   LEG 2 — the SAME vectors, UNCLASSIFIED (what the shipped bundle did),
 *     resolve to the attacker's origin. This leg is the proof that the vectors
 *     are not vacuous; it is also the leg that fails when the one-line call
 *     site in `createAuthorizationRequest` is reverted, which was measured on
 *     the real files, not argued (see the commit message).
 *
 * WHAT IT DELIBERATELY ASSERTS AS A MISS. Refusal is broader than escape: some
 * refused values (`/@evil.example`, a trailing U+2028, a bare relative path)
 * do resolve on-origin today, and they are refused anyway because the rule is
 * an ALLOW-LIST — it refuses what it cannot PROVE safe. They are written down
 * as refusals rather than deleted: an asserted miss is a boundary, a deleted
 * one is a lie.
 *
 * WHAT IT DOES NOT COVER. It does not run a browser, so it cannot prove that
 * `window.location.replace` behaves as `new URL(value, origin)` says it does —
 * that resolution is the SAME WHATWG algorithm the browser uses, and the sink
 * itself is one line, read by eye. It does not check the IdP side of the flow.
 *
 * RUNNER. `bun test tests/unit/open-redirect-return-to.test.ts` (the web
 * package ships no unit runner of its own — see the sibling
 * `consent-classification.test.ts` for why these files live under `tests/`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createAuthorizationRequest } from "../../src/shared/lib/oidc";
import { resolveOidcConfig } from "../../src/shared/lib/oidc-config";
import {
  DEFAULT_RETURN_TO,
  isSafeReturnTo,
  safeReturnTo,
} from "../../src/shared/lib/return-to";

/** The live host named in the finding. */
const APP_ORIGIN = "https://agents.vclawhub.com";

const OIDC_SOURCE = join(import.meta.dir, "../../src/shared/lib/oidc.ts");

/**
 * Where a navigation would land, by the parser the browser uses. A value that
 * throws is NOT the app origin either (see `escapesOffOrigin`).
 */
function landing(value: string): string {
  try {
    return new URL(value, APP_ORIGIN).origin;
  } catch {
    return "invalid-url";
  }
}

function escapesOffOrigin(value: string): boolean {
  return landing(value) !== APP_ORIGIN;
}

/**
 * LEG 2's control set: UNCLASSIFIED, each of these navigates somewhere that is
 * not the app. The first two are the shapes a reviewer would write; the middle
 * two are the reason the rule is an allow-list and not a list of bad
 * substrings — the URL parser rewrites a literal backslash to `/`, and strips
 * tab/newline anywhere, so both of those become `//evil.example`.
 */
const ESCAPES_OFF_ORIGIN = [
  "//evil.example",
  "///evil.example",
  "https://evil.example",
  "http://evil.example/signin",
  "/\\evil.example",
  "\\\\evil.example",
  "\\/\\/evil.example",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "\t//evil.example",
  " //evil.example",
  "//evil.example\n",
  "/\t/evil.example",
];

/**
 * Refused, though they happen to resolve on-origin: no rule can PROVE them
 * safe without decoding, so they are refused rather than repaired. The
 * comments record the measurement that puts each one here.
 */
const REFUSED_THOUGH_ON_ORIGIN = [
  "/@evil.example", // `@` is the authority separator; no route here needs it
  "/ev\u0000il.example", // NUL in a path — a control character, refused
  "/ev\u001fil.example", // and another one
  "/evil.example\u2028", // not stripped by the parser, but not provably safe
  "evil.example", // a relative path is not an absolute path
  "", // resolves to the origin itself; still not an absolute path
  "//", // two slashes and no host: an invalid URL, refused
];

/** KEPT: an absolute path on this origin, so it is returned unchanged. */
const KEPT = [
  "/",
  "/repos",
  "/repos/foo?tab=readme#top",
  "/invite/abc-123",
  "/?preview=repositories",
  "/a%20b", // a percent-encoded space is not a space
  "/%5C/evil.example", // measured: stays on-origin; passes as a literal path
  "/%2e%2e//evil.example", // dot-segment normalisation keeps the host
  "/..//evil.example",
  "/login?returnTo=//evil.example", // a same-origin path that re-enters /login
];

/** Absent or not a string: no preference, so the app root. */
const NOT_A_STRING = [
  undefined,
  null,
  42,
  true,
  {},
  ["/repos"],
  Symbol("/repos"),
];

describe("LEG 2 (control) — the vectors really do leave the origin", () => {
  test("every vector in the escape set lands off-origin when unclassified", () => {
    const stayed = ESCAPES_OFF_ORIGIN.filter((raw) => !escapesOffOrigin(raw));
    expect(
      stayed,
      `these do NOT escape, so they prove nothing and must move: ${stayed.join(", ")}`,
    ).toEqual([]);
    expect(ESCAPES_OFF_ORIGIN.length).toBeGreaterThanOrEqual(13);
  });

  test("the attack URL named in the finding is one of them", () => {
    // The exact request an attacker sends, and the value it carries.
    const attack =
      "https://agents.vclawhub.com/login?returnTo=https://evil.example";
    const carried = new URL(attack).searchParams.get("returnTo") ?? "";
    expect(carried).toBe("https://evil.example");
    expect(escapesOffOrigin(carried)).toBe(true);
  });
});

describe("LEG 1 — the classifier refuses everything it cannot prove safe", () => {
  test("a plain same-origin path is kept", () => {
    expect(safeReturnTo("/repos")).toBe("/repos");
    for (const raw of KEPT) {
      expect(isSafeReturnTo(raw)).toBe(true);
      expect(safeReturnTo(raw)).toBe(raw);
    }
    expect(KEPT).toContain("/repos");
  });

  test("every escaping vector is refused", () => {
    for (const raw of ESCAPES_OFF_ORIGIN) {
      expect(isSafeReturnTo(raw)).toBe(false);
      expect(safeReturnTo(raw)).toBe(DEFAULT_RETURN_TO);
    }
  });

  test("every unprovable value is refused", () => {
    for (const raw of REFUSED_THOUGH_ON_ORIGIN) {
      expect(isSafeReturnTo(raw)).toBe(false);
      expect(safeReturnTo(raw)).toBe(DEFAULT_RETURN_TO);
    }
  });

  test("an empty, absent or non-string value becomes /", () => {
    for (const raw of NOT_A_STRING) {
      expect(isSafeReturnTo(raw)).toBe(false);
      expect(safeReturnTo(raw)).toBe(DEFAULT_RETURN_TO);
    }
    expect(DEFAULT_RETURN_TO).toBe("/");
  });

  test("the named required vectors, one by one", () => {
    expect(safeReturnTo("/repos")).toBe("/repos");
    expect(safeReturnTo("//evil.example")).toBe("/");
    expect(safeReturnTo("https://evil.example")).toBe("/");
    expect(safeReturnTo("/\\evil.example")).toBe("/");
    expect(safeReturnTo("\\\\evil.example")).toBe("/");
    expect(safeReturnTo("javascript:alert(1)")).toBe("/");
    expect(safeReturnTo("/\u0000evil.example")).toBe("/");
    expect(safeReturnTo(" //evil.example")).toBe("/");
    expect(safeReturnTo("")).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
  });

  test("the escaped value is never returned as a repaired path", () => {
    // REJECT, DO NOT SANITISE: no prefix of the hostile input survives.
    for (const raw of ESCAPES_OFF_ORIGIN) {
      const out = safeReturnTo(raw);
      expect(out).not.toContain("evil.example");
      expect(out.startsWith("/")).toBe(true);
    }
  });

  test("whatever the classifier returns lands on the app origin", () => {
    const everything: unknown[] = [
      ...ESCAPES_OFF_ORIGIN,
      ...REFUSED_THOUGH_ON_ORIGIN,
      ...KEPT,
      ...NOT_A_STRING,
    ];
    for (const raw of everything) {
      expect(landing(safeReturnTo(raw))).toBe(APP_ORIGIN);
    }
  });
});

/** The production config, resolved the way the app resolves it. */
const CONFIG = resolveOidcConfig(undefined, APP_ORIGIN);

/** A discovery document that needs no network: only the endpoints and PKCE. */
const DISCOVERY = {
  issuer: "https://auth.vclawhub.com",
  authorization_endpoint: "https://auth.vclawhub.com/api/oidc/authorization",
  token_endpoint: "https://auth.vclawhub.com/api/oidc/token",
  code_challenge_methods_supported: ["S256"],
};

/**
 * The value the REAL `createAuthorizationRequest` puts in the flow record —
 * the same object `writeJson(FLOW_STORAGE_KEY, flow)` persists.
 */
async function storedReturnTo(value: string | null | undefined) {
  const request = await createAuthorizationRequest(CONFIG, {
    returnTo: value,
    discovery: DISCOVERY,
  });
  return request.flow.returnTo;
}

describe("THE CALL SITE — the stored flow never holds URL input", () => {
  test("a plain path is stored unchanged", async () => {
    expect(await storedReturnTo("/repos")).toBe("/repos");
  });

  test("no hostile or unprovable value is stored", async () => {
    for (const raw of [...ESCAPES_OFF_ORIGIN, ...REFUSED_THOUGH_ON_ORIGIN]) {
      expect(await storedReturnTo(raw)).toBe(DEFAULT_RETURN_TO);
    }
  });

  test("no `returnTo` at all is stored as the app root", async () => {
    expect(await storedReturnTo(undefined)).toBe(DEFAULT_RETURN_TO);
    expect(await storedReturnTo(null)).toBe(DEFAULT_RETURN_TO);
  });

  test("what auth.callback.tsx would navigate to is always this origin", async () => {
    // The sink is `window.location.replace(completed.returnTo ?? "/")`.
    for (const raw of [
      ...ESCAPES_OFF_ORIGIN,
      ...REFUSED_THOUGH_ON_ORIGIN,
      ...KEPT,
    ]) {
      const stored = await storedReturnTo(raw);
      expect(landing(stored ?? "/")).toBe(APP_ORIGIN);
    }
  });
});

describe("STRUCTURE — the rule sits where the value enters the flow", () => {
  const source = readFileSync(OIDC_SOURCE, "utf8");

  test("the flow record is classified before it is persisted", () => {
    const classifiedAt = source.indexOf("safeReturnTo(options?.returnTo)");
    const persistedAt = source.indexOf("writeJson(FLOW_STORAGE_KEY");
    expect(classifiedAt).toBeGreaterThan(-1);
    expect(persistedAt).toBeGreaterThan(-1);
    expect(classifiedAt).toBeLessThan(persistedAt);
  });

  test("the flow object cannot be handed the caller's value", () => {
    // `returnTo,` (the classified local) — never `returnTo: options.returnTo`.
    expect(source).not.toMatch(/returnTo:\s*options/);
    expect(source).not.toMatch(/returnTo:\s*options\?\.returnTo/);
    expect(source).toContain('from "./return-to"');
  });
});
