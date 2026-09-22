/**
 * THE REPOS COPY GUARDS — "the panel must not promise a capability this tier
 * cannot perform, and a link must point at a route that exists", as FAILING-BY-
 * DESIGN controls.
 *
 * WHERE THIS COMES FROM. Both defects were found, reported, fixed and DEPLOYED on
 * 2026-09-22, and both survived review precisely because NOTHING ASSERTED THEM:
 *
 *   1. `features/repos/ui/ConnectButton.tsx` told a user "Read, push and review in
 *      the browser instead". The tier has no push and no commit: `git-client.ts`
 *      imports clone/fetch/log/readBlob/readTree/resolveRef and its exported API is
 *      read-only. MEASURED in the then-served bundle `index-Dgj640Pw.js` and its
 *      successor: `grep -c "Read, push and review"` -> 1.
 *   2. `features/repos/ui/RepoDetailPage.tsx` linked `/channels/${repo.channelId}`,
 *      and `app/routes.ts` registers NO channel route — a link into the router's
 *      not-found.
 *
 * So an unasserted user-visible string is an unguarded one: the next edit is free to
 * re-promise push and review, and nothing would notice.
 *
 * WHAT IT ASSERTS — two mechanical properties, plus the positive control that makes
 * the negatives mean something:
 *
 *   CHECK 1 (copy): the panel CONTAINS the honest sentence, and no capability claim
 *     sits next to "in the browser". The adjacency rule is the only discriminator
 *     that works here, because BOTH the dishonest and the honest sentence mention
 *     the desktop app ("…works without the desktop app" / "need the desktop app"),
 *     so a rule of the form "push must appear near 'desktop app'" passes on the
 *     text it is meant to reject. What separates them is whether the capability is
 *     offered IN THE BROWSER.
 *   CHECK 2 (link): every static `href` in the repos feature must be compatible with
 *     a route registered in `app/routes.ts`. Not a list of banned paths — the real
 *     property. `/channels/…` fails it because no registered route begins `channels`.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING, for the reason the sibling file gives: the
 * explanation of a removed link NAMES the removed path, and a raw scan flags the
 * explanation as the offence. The wrong fix would be to stop explaining; instead the
 * checker ignores comments, and CONTROL 2 proves it still fires on real code.
 *
 * ITS LIMITS, STATED PLAINLY:
 *   - CHECK 1 is a copy check, not a capability check. It cannot tell whether the
 *     desktop app really can push — that is upstream's, and it lives in another tier.
 *   - CHECK 2 resolves only static prefixes: a literal href, or the part of a
 *     template literal before its first `${`. It cannot evaluate a path assembled at
 *     runtime, and it does not check that a dynamic segment's VALUE is valid.
 *   - Neither check can catch a promise phrased in words neither regex anticipates.
 *
 * RUNNER: `bun test tests/unit/repos-copy-guards.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./console-honesty-structure.test";

const SRC = join(import.meta.dir, "../../src");
const REPOS = join(SRC, "features/repos");
const CONNECT_BUTTON = join(REPOS, "ui/ConnectButton.tsx");
const ROUTES = join(SRC, "app/routes.ts");

const HONEST_SENTENCE = "Read the repositories in the browser instead";
const HONEST_QUALIFIER = "Pushing and review";

/** The sentence that was live until 2026-09-22 — kept as CONTROL 1's fixture. */
const RETIRED_SENTENCE = "Read, push and review in the browser instead";

/** A capability offered IN THE BROWSER, in either word order. */
const OFFER_IN_BROWSER = [
  /(?:push|commit|review)[^.\n]{0,40}in the browser/i,
  /in the browser[^.\n]{0,20}(?:push|commit|review)/i,
];

export function browserCapabilityClaims(source: string): string[] {
  const text = stripComments(source);
  return OFFER_IN_BROWSER.filter((re) => re.test(text)).map((re) => re.source);
}

/** Route patterns registered in the app, as segment lists. */
export function registeredRoutes(source: string): string[][] {
  const out: string[][] = [];
  const re = /route\(\s*"([^"]+)"/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    out.push(m[1].split("/").filter(Boolean));
    m = re.exec(source);
  }
  // the index route is registered as index("index.tsx") — the root path itself
  out.push([]);
  return out;
}

/**
 * True when the href's static prefix could belong to this route: compare segment by
 * segment, treating a dynamic segment (`$name` / `$`) as a wildcard and allowing the
 * prefix to be SHORTER than the route (a template literal truncated at its first
 * `${`, e.g. `/repos/` for `/repos/$repoId`).
 */
export function couldBeRoute(prefix: string, route: string[]): boolean {
  const parts = prefix.split("/").filter(Boolean);
  if (parts.length > route.length) return false;
  return parts.every(
    (part, i) => route[i].startsWith("$") || route[i] === part,
  );
}

/** Every static href in a source file: the literal, or the part before `${`. */
export function staticHrefPrefixes(
  source: string,
): { href: string; line: number }[] {
  const text = stripComments(source);
  const out: { href: string; line: number }[] = [];
  const re = /href\s*=\s*(?:\{`([^`]*)`\}|"([^"]*)"|\{`([^`]*)`\})/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    // A query string or hash is not part of the path: `/?preview=repositories` is the
    // INDEX route. The first run of this check fired on exactly that link, which is
    // how the omission was found — the checker, not the code, was wrong.
    const beforeQuery = raw.split(/[?#]/)[0];
    const beforeInterpolation = beforeQuery.split("${")[0];
    if (beforeInterpolation.startsWith("/")) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ href: beforeInterpolation, line });
    }
    m = re.exec(text);
  }
  return out;
}

describe("CHECK 1 — the panel promises only what this tier can do", () => {
  const source = readFileSync(CONNECT_BUTTON, "utf8");

  test("the honest sentence is present", () => {
    expect(source).toContain(HONEST_SENTENCE);
    expect(source).toContain(HONEST_QUALIFIER);
  });

  test("the retired sentence is gone", () => {
    expect(source).not.toContain(RETIRED_SENTENCE);
  });

  test("no capability claim sits next to 'in the browser'", () => {
    const claims = browserCapabilityClaims(source);
    expect(
      claims,
      `copy offers a capability in the browser: ${claims}`,
    ).toEqual([]);
    // and the rule is anchored on the real sentence, not on an empty file
    expect(browserCapabilityClaims(source)).toHaveLength(0);
    expect(source.length).toBeGreaterThan(1000);
  });
});

describe("CHECK 2 — links point at routes the app registers", () => {
  test("every static href in the repos feature resolves to a registered route", () => {
    const routes = registeredRoutes(readFileSync(ROUTES, "utf8"));
    expect(routes.length).toBeGreaterThan(5);

    const offences: string[] = [];
    for (const file of [
      "ui/RepoDetailPage.tsx",
      "ui/ReposPage.tsx",
      "ui/ConnectButton.tsx",
      "ui/RepoBlobViewer.tsx",
    ]) {
      const text = readFileSync(join(REPOS, file), "utf8");
      for (const { href, line } of staticHrefPrefixes(text)) {
        if (!routes.some((route) => couldBeRoute(href, route))) {
          offences.push(
            `${file}:${line} href ${href} matches no registered route`,
          );
        }
      }
    }
    expect(offences, offences.join("; ")).toEqual([]);
  });

  test("the channel id is still shown, as text", () => {
    const page = readFileSync(join(REPOS, "ui/RepoDetailPage.tsx"), "utf8");
    expect(page).toContain("repo.channelId");
  });
});

describe("CONTROLS — each checker fails on the real defect it was written for", () => {
  test("CONTROL 1 — the retired sentence is caught by the copy rule", () => {
    const retired = `<span>${RETIRED_SENTENCE}</span> — the dashboard works without the desktop app.`;
    expect(browserCapabilityClaims(retired).length).toBeGreaterThan(0);
    // …and the honest replacement is NOT caught by the same rule
    const honest = `<span>${HONEST_SENTENCE}</span> — the dashboard works without the desktop app. ${HONEST_QUALIFIER} need the desktop app.`;
    expect(browserCapabilityClaims(honest)).toEqual([]);
  });

  test("CONTROL 2 — the dead link is caught by the route rule", () => {
    const routes = registeredRoutes(readFileSync(ROUTES, "utf8"));
    // The fixture must contain the interpolation opener, so `${` is assembled rather
    // than written inside a plain string (biome's noTemplateCurlyInString, correctly).
    const INTERP = "$" + "{";
    const dead = "href={`/channels/" + INTERP + "repo.channelId}`}";
    const prefixes = staticHrefPrefixes(dead);
    expect(prefixes.map((p) => p.href)).toEqual(["/channels/"]);
    expect(
      prefixes.some((p) => routes.some((route) => couldBeRoute(p.href, route))),
    ).toBe(false);

    // the same extractor, on a href that IS registered — the negative above is not vacuous
    const live = "href={`/repos/" + INTERP + "repo.id}`}";
    const livePrefixes = staticHrefPrefixes(live);
    expect(livePrefixes.map((p) => p.href)).toEqual(["/repos/"]);
    expect(
      livePrefixes.some((p) =>
        routes.some((route) => couldBeRoute(p.href, route)),
      ),
    ).toBe(true);
  });
});
