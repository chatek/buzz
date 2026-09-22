/**
 * `?returnTo=` — where the browser lands AFTER a successful sign-in — is
 * ATTACKER-CONTROLLED INPUT, so this module is the one place that decides
 * whether a value may be navigated to.
 *
 * THE DEFECT IT CLOSES (found 2026-09-22, MEASURED against the served bundle
 * `/assets/index-SRXM6A06.js`, sha256
 * `cfb0dfe5f7132ec1fe8f6a3d114d660e29c194ed0bd2d2e6ad19e05fb74d4521`,
 * byte-identical to the deployed file):
 *
 *   - `app/routes/login.tsx` read `?returnTo=` and passed it to `signIn()`;
 *   - `shared/lib/oidc.ts` persisted it in the `buzz-oidc-flow`
 *     sessionStorage record, unchanged;
 *   - `app/routes/auth.callback.tsx` ran
 *     `window.location.replace(completed.returnTo ?? "/")`.
 *
 * `https://<app>/login?returnTo=https://evil.example` therefore ended a REAL
 * sign-in on the attacker's page. The credentials are genuine, the landing
 * page is not: a post-authentication open redirect.
 *
 * THE RULE — accept only a SAME-ORIGIN ABSOLUTE PATH; refuse everything else
 * and fall back to `/`:
 *   1. a string that starts with `/`;
 *   2. that does NOT start with `//` (protocol-relative: another host);
 *   3. whose remaining characters are ALL in the allow-list below.
 *
 * WHY AN ALLOW-LIST, NOT A LIST OF BAD SUBSTRINGS. Measured with WHATWG URL
 * resolution — `new URL(value, "https://agents.vclawhub.com")`, the same parser
 * the browser uses — `//evil.example`, `/\evil.example`, `\/\/evil.example`,
 * `/\t/evil.example`, `https://evil.example`, `javascript:alert(1)` and
 * `data:text/html,<script>` ALL resolve off-origin. Two of those show why a
 * deny-list cannot be trusted here: the parser REWRITES a literal backslash to
 * `/` (so `/\evil.example` becomes `//evil.example`), and it STRIPS tab,
 * newline and carriage return ANYWHERE in the string (so `/\t/evil.example`
 * becomes `//evil.example` as well). A deny-list must know every spelling the
 * parser accepts; an allow-list only has to name the characters that are safe.
 *
 * The allow-list therefore excludes every control character and space, the
 * backslash, `<`, `>`, `"`, `{`, `}`, the backtick, `|`, `^` and `@`. `@` is
 * refused because it is the authority separator (`good@evil.example`); no route
 * in this app needs it in a path.
 *
 * REJECT, DO NOT SANITISE. A value the rule cannot PROVE is a same-origin path
 * is replaced by `/`. It is never trimmed, un-escaped, decoded or repaired into
 * an acceptable one. (`/%5c/evil.example` does still resolve on-origin, because
 * a percent-encoded backslash is not the character the parser rewrites — it
 * passes only as the literal path it is, and the rule does not have to argue
 * that case.)
 *
 * ONE CLASSIFIER, ONE CALL SITE. `safeReturnTo` is applied where an untrusted
 * value enters the persisted flow (`shared/lib/oidc.ts`,
 * `createAuthorizationRequest`); every reader of a stored flow — today only
 * `app/routes/auth.callback.tsx` — inherits that guarantee. Do not add a second
 * switch at a sink: strengthen this one.
 */

/** Where an absent or refused `returnTo` lands: the app's own root. */
export const DEFAULT_RETURN_TO = "/";

/**
 * Every character allowed after the leading `/`: unreserved
 * (`A-Za-z0-9-._~`), the URL-safe sub-delimiters, and `% / ? # [ ]`. No phrase
 * in this class can start an authority: the string is anchored on ONE leading
 * `/`, and the characters that could build the second one — backslash, every
 * control character, every space — are excluded by construction.
 */
const SAFE_PATH_BODY = /^[A-Za-z0-9\-._~!$&'()*+,;=:%/?#[\]]*$/;

/**
 * True only for a value this module can PROVE is a same-origin absolute path.
 * Anything else — a non-string, an absent value, a scheme, a bare host, a
 * protocol-relative pair of slashes, a backslash, a control character — is
 * false, and the caller must refuse it.
 */
export function isSafeReturnTo(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return false;
  }
  if (value.startsWith("//")) {
    return false;
  }
  return SAFE_PATH_BODY.test(value.slice(1));
}

/**
 * The post-sign-in destination: `value` when it is provably a same-origin
 * absolute path, otherwise `DEFAULT_RETURN_TO`. A refusal is visible in the
 * return value, never implied by a silent edit to the input.
 */
export function safeReturnTo(value: unknown): string {
  return isSafeReturnTo(value) ? value : DEFAULT_RETURN_TO;
}
