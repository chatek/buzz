/**
 * UNIT TESTS for the single-total scanner, beside the module — and they exist
 * because of a finding I did not make myself.
 *
 * LANE 2 (worker2), `.prime/handoff/verify-lane/scanner-proof/scanner-proof.test.ts`
 * (13 tests, bun 1.4.0, reproduced here: 13 pass), proved that the first version of
 * this guard could not fail on the ordinary way an operator-facing total is
 * rendered: `<tr><th>Consents</th><td>281</td></tr>` puts the label and the value
 * in two text nodes, and a node-level scan sees neither as a violation. The guard's
 * own comment described that split while the guard could not observe it. There was
 * also NO unit test for the scanner at all — only the e2e spec. Both are fixed here.
 *
 * RUNNER. The web package has NO unit runner of its own: `package.json` declares
 * only `@playwright/test`, and there is not one `*.test.*` file under `src/`.
 * `bun test` is already used across this monorepo (`vendors/oh-my-pi/**`, and lane 2's
 * proof above), bun 1.4.0 is installed, and it needs no dependency, so this file uses
 * it rather than adding a runner:
 *
 *     bun test tests/unit/consent-classification.test.ts
 *
 * WHY IT IS HERE AND NOT BESIDE THE MODULE IN `src/`. MEASURED: a `*.test.ts` under
 * `src/` breaks `pnpm typecheck` — `src/features/admin/consent-classification.test.ts(29,40):
 * error TS2307: Cannot find module 'bun:test' or its corresponding type
 * declarations` — because `tsconfig.json` includes `["src"]` and this package has no bun
 * types. The fixes are to add a types dependency (a new dependency, which I was told not
 * to add) or to keep the file out of the typechecked program. So it lives under
 * `tests/unit/`, which is exactly where the e2e specs already live, importing the module
 * by relative path — the same pattern, one directory over.
 *
 * WHAT THIS FILE DELIBERATELY ASSERTS AS A MISS: digitless number words and
 * synonyms. They are OUT OF SCOPE for a word-and-number rule, they are written down
 * as misses rather than deleted, and lane 2's line is now the rule here — a green
 * `forbiddenSingleTotalsIn` is NOT coverage. An asserted miss is a boundary; a
 * deleted one is a lie. The real protection stays STRUCTURAL: the consent panel
 * renders named populations and never sums them.
 */

import { describe, expect, test } from "bun:test";

import {
  CONSENT_SCAN_CONTAINERS,
  CONSENT_TOTAL_ADJACENCY_WINDOW,
  CONSENT_UNIT_ADJACENCY_WINDOW,
  collectVisualUnits,
  consentNumberGap,
  findForbiddenSingleTotal,
  forbiddenSingleTotalsIn,
  forbiddenUnitsInTree,
  forbiddenVisualUnitsIn,
  type ScanElement,
} from "../../src/features/admin/consent-classification";

/** A container whose text is built from parts, the way a DOM would give it. */
function el(
  tag: string,
  parts: string[],
  children: ScanElement[] = [],
): ScanElement {
  return { tag, text: parts.join(" "), children };
}

/** textContent-style concatenation, for the "cells with no separator" control. */
function splittable(parts: string[]): string {
  return parts.join(" ");
}

describe("control — the shapes the node scan already caught (unchanged behaviour)", () => {
  test('"281 consents" in ONE text node is caught', () => {
    expect(findForbiddenSingleTotal("281 consents")).not.toBeNull();
  });

  test("a digitless label is caught", () => {
    expect(findForbiddenSingleTotal("Total consents")).not.toBeNull();
    expect(
      findForbiddenSingleTotal("the consent total is unchanged"),
    ).not.toBeNull();
  });

  test("a legitimate sentence with no number is NOT flagged", () => {
    expect(
      findForbiddenSingleTotal("No consent is required for this client."),
    ).toBeNull();
    expect(
      findForbiddenSingleTotal(
        "never answered — the consent screen was shown and no response was recorded",
      ),
    ).toBeNull();
  });

  test("an identifier token is not a label", () => {
    expect(
      findForbiddenSingleTotal("oauth2_consent_preconfiguration"),
    ).toBeNull();
    expect(
      findForbiddenSingleTotal(
        "every_consent_subject_resolves_to_a_username; 16 of 16",
      ),
    ).toBeNull();
  });

  test("the node window is pinned on both edges", () => {
    const at = (gap: number) => `consent${".".repeat(gap)}281`;
    expect(
      findForbiddenSingleTotal(at(CONSENT_TOTAL_ADJACENCY_WINDOW)),
    ).not.toBeNull();
    expect(
      findForbiddenSingleTotal(at(CONSENT_TOTAL_ADJACENCY_WINDOW + 1)),
    ).toBeNull();
    expect(findForbiddenSingleTotal("consent count: 281")).not.toBeNull();
    expect(
      findForbiddenSingleTotal(
        "design §3.6 requires an access row per consent read",
      ),
    ).toBeNull();
  });
});

describe("THE HOLE LANE 2 FOUND, and what the visual-unit scan does about it", () => {
  test("the node scan MISSES a label split from its value (asserted, not hidden)", () => {
    // <tr><th>Consents</th><td>281</td></tr> is two text nodes.
    expect(forbiddenSingleTotalsIn(["Consents", "281"])).toEqual([]);
    // …while a person plainly reads "Consents 281".
    expect(splittable(["Consents", "281"])).toBe("Consents 281");
  });

  test("the unit scan CATCHES the table row", () => {
    const tree = el(
      "table",
      [],
      [el("tr", [], [el("th", ["Consents"]), el("td", ["281"])])],
    );
    // "table" is not a container: the row is, so the row is the unit.
    expect(CONSENT_SCAN_CONTAINERS).not.toContain("table");
    expect(collectVisualUnits(tree)).toEqual(["Consents 281"]);
    expect(forbiddenUnitsInTree(tree)).toEqual(["Consents 281"]);
  });

  test("the unit scan CATCHES two spans in one card, marked as a scan unit", () => {
    const card: ScanElement = {
      tag: "div",
      text: "",
      scanUnit: true,
      children: [el("span", ["Total consents"]), el("span", ["281"])],
    };
    expect(forbiddenUnitsInTree(card)).toEqual(["Total consents 281"]);
    // A bare div is NOT a container, so a page section cannot become one unit.
    expect(collectVisualUnits({ ...card, scanUnit: false })).toEqual([]);
  });

  test("the unit scan CATCHES the same shapes at the tightest gaps", () => {
    expect(forbiddenVisualUnitsIn(["Consents281"])).toHaveLength(1); // cells, no separator
    expect(forbiddenVisualUnitsIn(["Consents\t281"])).toHaveLength(1);
    expect(forbiddenVisualUnitsIn(["Consents: 281"])).toHaveLength(1);
    expect(
      forbiddenVisualUnitsIn(["Consents (all clients): 281"]),
    ).toHaveLength(1);
  });

  test("the NEAREST container wins: units do not nest or sprawl", () => {
    const tree = el(
      "ul",
      [],
      [el("li", [], [el("span", ["Consents"]), el("span", ["281"])])],
    );
    expect(collectVisualUnits(tree)).toEqual(["Consents 281"]);
  });

  test("the unit window is pinned on both edges", () => {
    const unit = (gap: number) => `Consents${".".repeat(gap)}281`;
    expect(
      forbiddenVisualUnitsIn([unit(CONSENT_UNIT_ADJACENCY_WINDOW)]),
    ).toHaveLength(1);
    expect(
      forbiddenVisualUnitsIn([unit(CONSENT_UNIT_ADJACENCY_WINDOW + 1)]),
    ).toEqual([]);
  });
});

describe("no false positives at the measured floor, and the boundary beyond it", () => {
  test("the closest legitimate unit this console renders is NOT flagged (gap 25)", () => {
    const pendingRow =
      "Never answered 46 no never answered — the consent screen was shown and no response was recorded The screen was shown and no response was ever recorded";
    expect(consentNumberGap(pendingRow)).toBe(25);
    expect(forbiddenVisualUnitsIn([pendingRow])).toEqual([]);
  });

  test("the access-audit note is NOT flagged (gap 28)", () => {
    const auditNote =
      "this read is audited: sink log , persisted false . design §3.6 requires an access row per consent read; writing one is a WRITE and is Phase 2";
    expect(forbiddenVisualUnitsIn([auditNote])).toEqual([]);
  });

  test("a date range after the word is NOT a number (the measured false positive)", () => {
    // MEASURED at gap 8 before ISO date/time literals were excluded. A timestamp is
    // not a count, so excluding it is the honest fix; shrinking the window around it
    // would have made the visible split shapes unreachable.
    expect(
      consentNumberGap(
        "the window applied to the consent views: 2026-06-23T00:00:00Z",
      ),
    ).toBeNull();
    expect(
      forbiddenVisualUnitsIn([
        "the window applied to the consent views: 2026-06-23T00:00:00Z",
      ]),
    ).toEqual([]);
    // …and the exclusion opens no hole: the count beside a date still fires.
    expect(forbiddenVisualUnitsIn(["Consents (2026-09-21): 281"])).toHaveLength(
      1,
    );
  });
});

describe("POSITIVE CONTROL — legitimate copy the guard DOES flag (the safe direction)", () => {
  // Lane 2's case, kept and recorded rather than "fixed": the rule fires on ANY
  // nearby number, not on the total. For a forbidden-content guard that is the safe
  // direction, and it is why the unit scan is bounded to real containers.
  test('"Consents expire after 30 days" is flagged', () => {
    expect(
      findForbiddenSingleTotal("Consents expire after 30 days"),
    ).not.toBeNull();
    expect(
      forbiddenVisualUnitsIn(["Consents expire after 30 days"]),
    ).toHaveLength(1);
  });

  test("the control set is not made only of violations", () => {
    expect(
      forbiddenVisualUnitsIn(["Consent policy: two scopes require no prompt"]),
    ).toEqual([]);
    expect(
      forbiddenVisualUnitsIn(["Rows with no response timestamp 46"]),
    ).toEqual([]);
  });
});

describe("OUT OF SCOPE — asserted MISSES (a boundary, not an oversight)", () => {
  test("a number written as a word is NOT caught: the rule needs a digit", () => {
    expect(
      findForbiddenSingleTotal("two hundred and eighty-one consents"),
    ).toBeNull();
    expect(
      forbiddenVisualUnitsIn(["Consents: two hundred and eighty-one"]),
    ).toEqual([]);
  });

  test("a synonym for the total is NOT caught: the rule needs the word", () => {
    expect(findForbiddenSingleTotal("Decisions: 281")).toBeNull();
    expect(findForbiddenSingleTotal("Approvals 281")).toBeNull();
    expect(forbiddenVisualUnitsIn(["Decisions: 281", "Approvals 281"])).toEqual(
      [],
    );
  });

  test("a label separated from its value by a long phrase is NOT caught (gap > 18)", () => {
    const far =
      "Consents recorded for all clients in this environment, see the table below: 281";
    expect(consentNumberGap(far)).toBeGreaterThan(
      CONSENT_UNIT_ADJACENCY_WINDOW,
    );
    expect(forbiddenVisualUnitsIn([far])).toEqual([]);
  });
});
