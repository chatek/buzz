import { expect, test, type Page } from "@playwright/test";

import {
  CONSENT_SCAN_CONTAINERS,
  collectVisualUnits,
  forbiddenSingleTotalsIn,
  forbiddenVisualUnitsIn,
  type ScanElement,
} from "../../src/features/admin/consent-classification";
import { liveClientsPayload } from "../../src/features/admin/idp-fixture-live";

/**
 * THE ADMIN CONSOLE (phase 1, read-only).
 *
 * WHAT THESE TESTS ARE FOR, given that the live gateway refuses every read
 * today (nil admission function, endpoints not yet mounted):
 *
 *  1. The classification is VERIFIABLE before admission lands. The staged
 *     captures drive the real components through the real read seam, so the
 *     five-way split, the "real user answers" arithmetic and the consistency
 *     lines are checked, not assumed.
 *  2. NOTHING IS TRANSCRIBED INTO THE RENDER PATH. The same components render
 *     two captures with different numbers, and each is required to show its own.
 *  3. THE RULE THAT MATTERS: no rendered text pairs a number with the word
 *     "consent(s)", at EITHER granularity — a text node, or the VISUAL UNIT that a
 *     person actually reads (a table row, a definition list, a list item, a card).
 *     The unit granularity exists because LANE 2 (worker2,
 *     `.prime/handoff/verify-lane/scanner-proof/`) proved the node scan cannot see
 *     the ordinary shape `<tr><th>Consents</th><td>281</td></tr>`, where label and
 *     value are different text nodes. Both granularities are the feature's own
 *     exported rules — this file supplies only the DOM adapter — and both are
 *     proven able to FAIL: the node scan by injecting "281 consents", the unit
 *     scan by injecting the split markup itself.
 *  4. The closed states are honest: a 401 says "Not authorized yet", a 501 says
 *     the surface is not mounted, a 503 quotes the service, and none of them
 *     renders an empty table, a fake row, or a spinner left running.
 *  5. THE LIVE HTTP PATH WORKS, not only the fixture map: one test stubs the
 *     gateway over HTTP, fulfils one endpoint with a recorded payload and
 *     refuses another, and requires the console to show both states at once.
 *
 * NOTE ON REACHING THE PAGE. `/admin` is registered by one line in
 * `src/app/routes.ts`, which this lane does not own (the lead does). These tests
 * run against a build that HAS that line; the transcript of the same suite
 * failing without it is in `.prime/handoff/idp-build/j18/`.
 */

const LIVE_FIXTURE = "live-2026-09-21";
const ALTERNATE_FIXTURE = "alternate-with-defect";

/**
 * Every non-empty text node of the rendered page. Text nodes, not element text:
 * the granularity of "a phrase that labels a number" is one node, so a heading
 * and a separate number cell are not glued together by the scanner.
 */
async function renderedTextNodes(
  page: Page,
  inject?: string,
): Promise<string[]> {
  return page.evaluate((extra) => {
    if (extra) {
      const probe = document.createElement("p");
      probe.textContent = extra;
      document.body.appendChild(probe);
    }
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const out: string[] = [];
    let node = walker.nextNode();
    while (node) {
      const text = (node.nodeValue ?? "").trim();
      if (text.length > 0) out.push(text);
      node = walker.nextNode();
    }
    return out;
  }, inject ?? null);
}

/** Offending text nodes: a number rendered as "consents". Must be empty. */
async function forbiddenConsentTotals(page: Page): Promise<string[]> {
  return forbiddenSingleTotalsIn(await renderedTextNodes(page));
}

/**
 * THE DOM ADAPTER — the only DOM code in this file, and the only thing the
 * feature's traversal does not own. It builds the descriptor shape that
 * `collectVisualUnits` walks; the rule and the unit selection stay in the module,
 * so the unit test beside that module and this spec exercise the SAME code.
 *
 * It runs inside the page, so it must be self-contained: the container list is
 * passed in rather than closed over.
 */
const DOM_DESCRIPTOR = (containers: string[]): unknown => {
  const wanted = new Set(containers.map((tag) => tag.toLowerCase()));
  const toDescriptor = (el: Element): unknown => ({
    tag: el.tagName.toLowerCase(),
    text: Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => (node.nodeValue ?? "").replace(/\s+/g, " ").trim())
      .filter((text) => text !== "")
      .join(" "),
    scanUnit:
      el.hasAttribute("data-scan-unit") || wanted.has(el.tagName.toLowerCase()),
    children: Array.from(el.children).map(toDescriptor),
  });
  return toDescriptor(document.body);
};

/** The visual units of the rendered page, in the feature's own unit selection. */
async function renderedScanUnits(page: Page): Promise<string[]> {
  const descriptor = (await page.evaluate(DOM_DESCRIPTOR, [
    ...CONSENT_SCAN_CONTAINERS,
  ])) as ScanElement;
  return collectVisualUnits(descriptor);
}

/** Offending visual units: a label and its value read together, as a person reads them. */
async function forbiddenConsentUnits(page: Page): Promise<string[]> {
  return forbiddenVisualUnitsIn(await renderedScanUnits(page));
}

/** Both granularities at once. Both must be empty on a page that holds the rule. */
async function forbiddenConsentOnPage(
  page: Page,
): Promise<{ nodes: string[]; units: string[] }> {
  return {
    nodes: forbiddenSingleTotalsIn(await renderedTextNodes(page)),
    units: await forbiddenConsentUnits(page),
  };
}

/**
 * Bare numbers inside the active panel: a text node that IS a number (`281`), as
 * opposed to a sentence containing one (`HTTP 401`). A panel that answers "we did
 * not get an answer" must contain none.
 */
async function bareNumbersInPanel(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid^="admin-tab-panel-"]');
    if (!panel) return ["NO PANEL RENDERED"];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    const out: string[] = [];
    let node = walker.nextNode();
    while (node) {
      const text = (node.nodeValue ?? "").trim();
      if (/^\d[\d,]*$/.test(text)) out.push(text);
      node = walker.nextNode();
    }
    return out;
  });
}

/** The split shape the guard exists to prevent, injected as REAL markup. */
const SPLIT_TOTAL_MARKUP =
  "<tbody><tr><th>Consents</th><td>281</td></tr></tbody>";

test("staged capture: the five populations, and no single consents number", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=consent`);

  // The capture says what it is, on the page, before any number.
  await expect(page.getByTestId("staged-data-banner")).toBeVisible();
  await expect(page.getByTestId("staged-data-banner")).toContainText(
    "STAGED DATA",
  );

  // Each population carries its own number: 130 / 99 / 5 / 1 / 46, defect 0.
  await expect(
    page.getByTestId("consent-population-count-auto_admitted"),
  ).toHaveText("130");
  await expect(
    page.getByTestId("consent-population-count-approved"),
  ).toHaveText("99");
  await expect(page.getByTestId("consent-population-count-partial")).toHaveText(
    "5",
  );
  await expect(page.getByTestId("consent-population-count-refused")).toHaveText(
    "1",
  );
  await expect(page.getByTestId("consent-population-count-pending")).toHaveText(
    "46",
  );
  await expect(
    page.getByTestId("consent-population-count-inconsistent"),
  ).toHaveText("0");

  // Nobody was asked about 130 of them, so they are not approvals; 46 were never
  // answered, so they are not refusals.
  await expect(
    page.getByTestId("consent-population-auto_admitted"),
  ).toContainText("not an approval");
  await expect(page.getByTestId("consent-population-pending")).toContainText(
    "not a refusal",
  );

  // Real user answers are computed as approved + partial + refused (105), never
  // as the row count (281).
  await expect(page.getByTestId("consent-answered")).toContainText("105");
  await expect(page.getByTestId("consent-total-rows")).toContainText("281");

  // The browser-side partition checks must all hold for this capture.
  for (const id of [
    "populations_partition_the_rows",
    "answered_is_approved_partial_refused",
    "pending_plus_responded_equals_total",
    "defect_bucket_is_empty",
    "states_match_populations",
  ]) {
    await expect(page.getByTestId(`consent-consistency-${id}`)).toHaveAttribute(
      "data-ok",
      "true",
    );
  }

  // With no defect in this capture, no derived upper-bound note appears.
  await expect(page.getByTestId("consent-pending-derived")).toHaveCount(0);

  // THE RULE, at BOTH granularities: no stray text node, and no VISUAL UNIT that
  // reads as a label plus a number.
  expect(await forbiddenConsentOnPage(page)).toEqual({ nodes: [], units: [] });
});

/**
 * The scanner's window is pinned on BOTH sides. `gap` makes the distance between
 * the word and the number explicit, so this test fails if the window is changed
 * without the change being deliberate.
 */
function consentThenNumber(gap: number): string {
  return `consent${".".repeat(gap)}281`;
}

test("the forbidden-total scanner can fail, and its window is pinned both sides", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=consent`);
  expect(await forbiddenConsentTotals(page)).toEqual([]);

  // Inject the exact shape the rule forbids. A guard that cannot fail proves
  // nothing about the page it passed.
  const texts = await renderedTextNodes(page, "281 consents");
  expect(forbiddenSingleTotalsIn(texts)).toEqual(["281 consents"]);

  // FIRES: the escape that defeated the old phrase-based form, at a gap of 8.
  expect(consentThenNumber(8).endsWith("281")).toBe(true);
  expect(
    forbiddenSingleTotalsIn(["consent count: 281"]) /* gap 8 */,
  ).toHaveLength(1);
  expect(forbiddenSingleTotalsIn(["Consent (281)"])).toHaveLength(1);
  expect(forbiddenSingleTotalsIn(["281 consents"])).toHaveLength(1);

  // THE BOUNDARY, exactly: gap 20 fires, gap 21 does not.
  expect(forbiddenSingleTotalsIn([consentThenNumber(20)])).toHaveLength(1);
  expect(forbiddenSingleTotalsIn([consentThenNumber(21)])).toEqual([]);

  // DIGITLESS forbidden labels, a different shape (no number is needed for a
  // label to claim a total of decisions).
  expect(forbiddenSingleTotalsIn(["total consents"])).toHaveLength(1);
  expect(
    forbiddenSingleTotalsIn(["the consent total is unchanged"]),
  ).toHaveLength(1);

  // PASSES on the left: a number far from the word, measured from the copy the
  // console actually renders (the access-audit note, gap 26).
  expect(
    forbiddenSingleTotalsIn([
      "design §3.6 requires an access row per consent read",
    ]),
  ).toEqual([]);

  // PASSES: no number at all, however close the word — this is what keeps the
  // server's own label for the never-answered population safe.
  expect(
    forbiddenSingleTotalsIn([
      "never answered — the consent screen was shown and no response was recorded",
    ]),
  ).toEqual([]);
  // PASSES: the word is part of an identifier token, not a label.
  expect(
    forbiddenSingleTotalsIn([
      "oauth2_consent_preconfiguration is NOT consent: it is counted and labelled",
    ]),
  ).toEqual([]);
  expect(
    forbiddenSingleTotalsIn([
      "every_consent_subject_resolves_to_a_username; 16 of 16",
    ]),
  ).toEqual([]);
});

test("a page-level label/value split is caught by the unit scan, and missed by the node scan", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=consent`);

  // The shipped page holds the rule at BOTH granularities before anything is injected.
  expect(await forbiddenConsentOnPage(page)).toEqual({ nodes: [], units: [] });
  expect((await renderedScanUnits(page)).length).toBeGreaterThan(0);

  // Inject the shape lane 2 proved the node scan cannot see — as real markup, in
  // the DOM, because that is where the shape lives:
  //   <tr><th>Consents</th><td>281</td></tr>
  await page.evaluate((markup) => {
    const table = document.createElement("table");
    table.setAttribute("data-testid", "injected-split-total");
    table.innerHTML = markup;
    document.body.appendChild(table);
  }, SPLIT_TOTAL_MARKUP);
  await expect(page.getByTestId("injected-split-total")).toBeVisible();

  // The NODE scan still misses it — asserted as a miss, so the reason the unit
  // scan exists cannot be quietly deleted.
  expect(forbiddenSingleTotalsIn(await renderedTextNodes(page))).toEqual([]);

  // The UNIT scan catches it, in the DOM, with the label and the value read as one.
  const offending = await forbiddenConsentUnits(page);
  expect(offending).toContain("Consents 281");
});

test("every view holds the rule at both granularities", async ({ page }) => {
  // The unit scan is measured against the WHOLE page, not one panel: the closest
  // legitimate unit in the shipped copy sits 25 characters from the word and the
  // access-audit note at 28, and this test is what fails if that margin is eaten.
  for (const tab of ["consent", "clients", "audit", "health"]) {
    await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=${tab}`);
    await expect(page.getByTestId(`admin-tab-panel-${tab}`)).toBeVisible();
    expect(await forbiddenConsentOnPage(page), `${tab} view`).toEqual({
      nodes: [],
      units: [],
    });
  }
});

test("a payload that OMITS a count shows the absence, not a zero", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=partial-payload&tab=consent`);

  // `totals.responded` is not in this capture. The card must say so, and the
  // absence branch is identified by data-value, not by matching prose.
  for (const testId of [
    "consent-total-rows",
    "consent-responded",
    "consent-subjects",
    "consent-clients",
  ]) {
    const card = page.getByTestId(testId);
    await expect(card).toHaveAttribute("data-value", "absent");
    await expect(card).toContainText("the payload did not report");
  }
  // A field the payload DID carry is still a number: `pending` is one of the
  // populations, which come from a struct rather than from a map.
  await expect(page.getByTestId("consent-pending")).toHaveAttribute(
    "data-value",
    "present",
  );
  await expect(page.getByTestId("consent-pending")).toContainText("46");
  // The derived answer count is still computed, because its inputs are present.
  await expect(page.getByTestId("consent-answered")).toContainText("105");
  // The prose that used the missing total as a denominator does not invent one.
  await expect(page.getByTestId("admin-tab-panel-consent")).toContainText(
    "no denominator is shown",
  );
  // A consistency line whose inputs are missing reports "could not check" rather
  // than a pass or a fail.
  await expect(
    page.getByTestId("consent-consistency-pending_plus_responded_equals_total"),
  ).toHaveAttribute("data-ok", "false");
  await expect(
    page.getByTestId("consent-consistency-pending_plus_responded_equals_total"),
  ).toContainText("could not check");
  await expect(page.getByTestId("consent-out-of-scope")).toContainText(
    "did not report an out-of-scope row count",
  );

  // The client inventory: a missing TOTAL must not be filled with the array length.
  await page.goto(`/admin?fixture=partial-payload&tab=clients`);
  await expect(page.getByTestId("clients-total")).toHaveAttribute(
    "data-value",
    "absent",
  );
  await expect(page.getByTestId("clients-total")).toContainText(
    "did not report the inventory size",
  );
  //…while a missing `visible` IS filled, because the rendered rows are the same
  // quantity observed directly. Recorded here so the difference is deliberate.
  await expect(page.getByTestId("clients-visible")).toHaveAttribute(
    "data-value",
    "present",
  );

  // The audit view: only the in-scope total is carried; the rest must be absences.
  await page.goto(`/admin?fixture=partial-payload&tab=audit`);
  await expect(page.getByTestId("audit-total")).toContainText("346");
  for (const testId of ["audit-ok", "audit-failed", "audit-banned"]) {
    await expect(page.getByTestId(testId)).toHaveAttribute(
      "data-value",
      "absent",
    );
  }
});

test("a refused read renders NO count card, no bare number, and no spinner", async ({
  page,
}) => {
  const cases = [
    {
      name: "401 admission refusal",
      kind: "not_authorized",
      fulfil: {
        status: 401,
        body: { error: "restricted: missing Authorization" },
      },
    },
    {
      name: "501 unmounted",
      kind: "not_mounted",
      fulfil: { status: 501, body: { error: "not implemented" } },
    },
    {
      name: "503 refused-not-empty",
      kind: "unavailable",
      fulfil: {
        status: 503,
        body: {
          error: "read model unavailable",
          detail: "no data source wired",
        },
      },
    },
    { name: "transport failure", kind: "unreachable", abort: true },
  ] as const;

  for (const scenario of cases) {
    await page.route("**/api/idp/clients", async (route) => {
      if ("abort" in scenario && scenario.abort) {
        await route.abort("failed");
        return;
      }
      const fulfil = (scenario as { fulfil: { status: number; body: unknown } })
        .fulfil;
      await route.fulfill({
        status: fulfil.status,
        contentType: "application/json",
        body: JSON.stringify(fulfil.body),
      });
    });
    await page.goto("/admin?tab=clients");
    const notice = page.getByTestId("idp-closed-notice");
    await expect(notice, scenario.name).toBeVisible();
    await expect(notice, scenario.name).toHaveAttribute(
      "data-kind",
      scenario.kind,
    );
    // No count card at all: not a zeroed card, not an empty one.
    await expect(
      page.locator("[data-number-card]"),
      `${scenario.name} must not render a count card`,
    ).toHaveCount(0);
    // No spinner left running.
    await expect(page.getByTestId("idp-panel-loading")).toHaveCount(0);
    // No BARE number anywhere inside the panel: a digit on its own would read as a
    // count that was never returned.
    expect(
      await bareNumbersInPanel(page),
      `${scenario.name} must not render a bare number`,
    ).toEqual([]);
    await page.unroute("**/api/idp/clients");
  }
});

test("a legitimately empty page is not an empty population", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=empty-page&tab=consent`);
  await expect(page.getByTestId("admin-tab-panel-consent")).toContainText(
    "empty page is not an empty population",
  );
  // The counts still report the filter set, so the zero is contextual rather than
  // an absence of an answer.
  await expect(page.getByTestId("consent-total-rows")).toHaveAttribute(
    "data-value",
    "present",
  );
  // And every population is a reported zero, not a missing bucket.
  for (const state of [
    "approved",
    "partial",
    "refused",
    "auto_admitted",
    "pending",
    "inconsistent",
  ]) {
    await expect(
      page.getByTestId(`consent-population-count-${state}`),
    ).toHaveText("0");
  }
});

test("a second capture with different numbers is rendered as its own", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=${ALTERNATE_FIXTURE}&tab=consent`);

  // Different numbers than the first capture, from the same components.
  await expect(
    page.getByTestId("consent-population-count-auto_admitted"),
  ).toHaveText("12");
  await expect(
    page.getByTestId("consent-population-count-approved"),
  ).toHaveText("7");
  await expect(page.getByTestId("consent-population-count-partial")).toHaveText(
    "2",
  );
  await expect(page.getByTestId("consent-population-count-refused")).toHaveText(
    "3",
  );
  await expect(page.getByTestId("consent-population-count-pending")).toHaveText(
    "10",
  );
  await expect(
    page.getByTestId("consent-population-count-inconsistent"),
  ).toHaveText("1");
  await expect(page.getByTestId("consent-answered")).toContainText("12");
  await expect(page.getByTestId("consent-total-rows")).toContainText("34");

  // One unclassifiable row breaks the partition, and the console says so rather
  // than showing a tidy table. The six populations sum to 35 against 34 in scope,
  // because the service counts the defective row as never answered AND as
  // unclassifiable.
  await expect(
    page.getByTestId("consent-consistency-populations_partition_the_rows"),
  ).toHaveAttribute("data-ok", "false");
  await expect(
    page.getByTestId("consent-consistency-defect_bucket_is_empty"),
  ).toHaveAttribute("data-ok", "false");
  // The other relations still hold, and are reported as holding: the defect is
  // localized instead of smeared over every line.
  await expect(
    page.getByTestId("consent-consistency-pending_plus_responded_equals_total"),
  ).toHaveAttribute("data-ok", "true");
  await expect(
    page.getByTestId(
      "consent-consistency-answered_is_approved_partial_refused",
    ),
  ).toHaveAttribute("data-ok", "true");

  // While a defect exists the never-answered figure is an upper bound, and the
  // console derives the true population in the browser and says that it did.
  await expect(page.getByTestId("consent-pending-derived")).toContainText(
    "9 rows",
  );

  expect(await forbiddenConsentOnPage(page)).toEqual({ nodes: [], units: [] });
});

test("the header reports what the page observed, and names the state it saw", async ({
  page,
}) => {
  /**
   * `data-outcome` IS NOT A DISCRIMINANT. MEASURED: 401 and not-mounted both render
   * `refused`, on purpose — it is a bucket. So no assertion here keys on it alone:
   * each case asserts the NOTICE's `data-kind` and the HEADER's SENTENCE, which are
   * what actually separate the states.
   */
  const headerFor = async (status: number, body: unknown) => {
    await page.route("**/api/idp/health", async (route) => {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.goto("/admin?tab=health");
    const header = page.getByTestId("surface-observation");
    await expect(header).toBeVisible();
    const sentence = (await header.textContent()) ?? "";
    await page.unroute("**/api/idp/health");
    return sentence;
  };

  // 401 — refused at admission.
  const refused = await headerFor(401, {
    error: "restricted: missing Authorization",
  });
  expect(refused).toContain("refused at admission (HTTP 401)");
  expect(refused).not.toContain("does not match any state");

  // 501 — nothing mounted. A DIFFERENT state, and the sentence says so, even though
  // the outcome bucket is the same one.
  const unmounted = await headerFor(501, { error: "not implemented" });
  expect(unmounted).toContain("nothing was mounted at the path it asked for");
  expect(unmounted).not.toContain("refused at admission");

  // 403 — THE DEFECT LANE 2 FOUND. Before the fix the notice said "Restricted" and
  // the header said "does not match any state the console knows": one event, two
  // surfaces, contradictory. Both now read one exhaustive table.
  const restricted = await headerFor(403, {
    error: "restricted: client nextcrm is not in your scope",
  });
  expect(restricted).toContain(
    "the authority check declined the read (HTTP 403)",
  );
  expect(restricted).not.toContain("does not match any state");
  // …and the notice for the same status carries the matching title.
  await page.route("**/api/idp/health", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: "restricted: client nextcrm is not in your scope",
      }),
    });
  });
  await page.goto("/admin?tab=health");
  const notice = page.getByTestId("idp-closed-notice");
  await expect(notice).toHaveAttribute("data-kind", "restricted");
  await expect(page.getByTestId("idp-closed-title")).toHaveText("Restricted");
  await expect(page.getByTestId("idp-closed-evidence")).toContainText(
    "restricted: client nextcrm is not in your scope",
  );
  await page.unroute("**/api/idp/health");

  // STAGED — no gateway was contacted, and the outcome bucket says exactly that.
  await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=consent`);
  await expect(page.getByTestId("surface-observation")).toHaveAttribute(
    "data-outcome",
    "staged",
  );
  await expect(page.getByTestId("surface-observation")).toContainText(
    "No gateway was contacted",
  );
});

test("a REFUSED read says WHEN the page looked, and the time MOVES", async ({
  page,
}) => {
  // LANE 2 found that `readAt` came from `dataUpdatedAt`, which is null on error —
  // so a refused read could not say when it was taken, while staged data could.
  // That is backwards: the failed read is the one where "when did we look?" matters.
  await page.route("**/api/idp/health", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "restricted: missing Authorization" }),
    });
  });

  const stampOf = async () => {
    const header = page.getByTestId("surface-observation");
    await expect(header).toBeVisible();
    const stamp = (await header.getAttribute("data-read-at")) ?? "";
    return stamp;
  };

  await page.goto("/admin?tab=health");
  const first = await stampOf();
  expect(first, "a refused read must carry a time").toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
  await expect(page.getByTestId("surface-observation")).toContainText(first);

  // A second look, separated in time: a fresh page load takes a fresh probe.
  await page.waitForTimeout(1100);
  await page.goto("/admin?tab=health");
  const second = await stampOf();
  expect(second).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // THE ASSERTION THAT MATTERS: the stamp MOVES. A constant would pass a presence
  // check and prove nothing about an observation.
  const differs = (a: string, b: string) => a !== b;
  expect(differs(first, second), `${first} vs ${second}`).toBe(true);
  // CONTROL: a hard-coded stamp FAILS that same predicate, which is what makes the
  // assertion above a test rather than a formality.
  expect(differs(first, first)).toBe(false);
});

test("a refused read is 'Not authorized yet', never an empty table", async ({
  page,
}) => {
  // THE LIVE WORDING, MEASURED: every `/api/idp/*` path on the deployed estate
  // answers 401 `{"error":"restricted: missing Authorization"}` today, because
  // the whole subtree sits behind the NIP-98 wrapper, which fails closed before
  // the dispatcher is reached. This is the body a real console visitor gets.
  await page.route("**/api/idp/clients", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "restricted: missing Authorization" }),
    });
  });

  await page.goto("/admin?tab=clients");

  const notice = page.getByTestId("idp-closed-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-kind", "not_authorized");
  await expect(page.getByTestId("idp-closed-title")).toHaveText(
    "Not authorized yet",
  );
  // The service's own sentence, with its error vocabulary intact.
  await expect(page.getByTestId("idp-closed-evidence")).toContainText(
    "restricted: missing Authorization",
  );
  // No spinner, no empty table, no invented row.
  await expect(page.getByTestId("idp-panel-loading")).toHaveCount(0);
  await expect(page.getByTestId("client-row-buzz-web")).toHaveCount(0);
  await expect(page.getByTestId("clients-total")).toHaveCount(0);
  await expect(page.getByTestId("idp-empty-note")).toHaveCount(0);
});

test("an unmounted surface is named as unmounted (the gateway's own 501)", async ({
  page,
}) => {
  await page.route("**/api/idp/clients", async (route) => {
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "not implemented" }),
    });
  });

  await page.goto("/admin?tab=clients");

  const notice = page.getByTestId("idp-closed-notice");
  await expect(notice).toHaveAttribute("data-kind", "not_mounted");
  await expect(page.getByTestId("idp-closed-title")).toHaveText(
    "This surface is not mounted",
  );
  await expect(notice).toContainText("surface not mounted");
  await expect(page.getByTestId("idp-closed-evidence")).toContainText(
    "not implemented",
  );
});

test("a 503 quotes the service instead of showing zeroes", async ({ page }) => {
  await page.route("**/api/idp/consent**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "read model unavailable",
        detail:
          "admin: schema mismatch: migrations max(id) = 17, this build reads migration 15; refusing to read a shape it was not built against",
      }),
    });
  });

  await page.goto("/admin?tab=consent");

  const notice = page.getByTestId("idp-closed-notice");
  await expect(notice).toHaveAttribute("data-kind", "unavailable");
  await expect(page.getByTestId("idp-closed-title")).toHaveText(
    "The read model is not answering",
  );
  await expect(notice).toContainText("this build reads migration 15");
  await expect(
    page.getByTestId("consent-population-count-approved"),
  ).toHaveCount(0);
  await expect(page.getByTestId("consent-total-rows")).toHaveCount(0);
});

test("the live HTTP path renders an inventory, and refuses its neighbour", async ({
  page,
}) => {
  // One endpoint answers with a recorded payload over HTTP; its neighbour is
  // refused. The console must show the inventory AND the refusal at once.
  await page.route("**/api/idp/clients", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(liveClientsPayload),
    });
  });
  await page.route("**/api/idp/consent/summary**", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: "restricted: unknown npub (no registry yet)",
      }),
    });
  });

  await page.goto("/admin?tab=clients");

  await expect(page.getByTestId("live-data-banner")).toBeVisible();
  await expect(page.getByTestId("staged-chip")).toHaveCount(0);
  await expect(page.getByTestId("client-row-buzz-web")).toBeVisible();
  await expect(page.getByTestId("client-row-buzz-web")).toContainText(
    "required",
  );
  await expect(page.getByTestId("clients-total")).toContainText("9");
  // No secret value is rendered, and no placeholder that looks like one.
  await expect(page.getByTestId("client-row-nextcrm")).toContainText("stored");
  await expect(page.locator("body")).not.toContainText("••••");
  // The refused neighbour is a closed notice inside the ready panel.
  await expect(page.getByTestId("idp-closed-notice")).toBeVisible();
  await expect(page.getByTestId("idp-closed-notice")).toHaveAttribute(
    "data-kind",
    "not_authorized",
  );
});

test("the audit view counts sessions and refuses to attribute them", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=audit`);

  await expect(page.getByTestId("audit-total")).toContainText("346");
  await expect(page.getByTestId("audit-banned")).toContainText("1");
  // The cause of a denial is not in this database, and the view says so.
  await expect(page.getByTestId("audit-denial-reason")).toContainText(
    "journal line",
  );
  await expect(page.getByTestId("audit-row-343")).toContainText("banned");
  // A request PATH is shown; the query string is not.
  await expect(page.getByTestId("audit-row-346")).toContainText(
    "/api/oidc/callback",
  );

  await expect(page.getByTestId("sessions-dbsize")).toContainText("23");
  await expect(page.getByTestId("sessions-attribution")).toContainText(
    "NOT BUILT",
  );
});

test("the health view separates a failed invariant from an unchecked one", async ({
  page,
}) => {
  await page.goto(`/admin?fixture=${ALTERNATE_FIXTURE}&tab=health`);

  await expect(page.getByTestId("health-status")).toHaveAttribute(
    "data-ok",
    "false",
  );
  await expect(
    page.getByTestId("invariant-idp_jwks_reachable"),
  ).toHaveAttribute("data-ok", "false");
  await expect(
    page.getByTestId("invariant-every_row_classified_exactly_once"),
  ).toHaveAttribute("data-unproven", "true");
  // Every reported count travels with the statement that produced it.
  await expect(page.getByTestId("assertion-consent_total")).toContainText(
    "select count(*) from oauth2_consent_session",
  );
  await expect(page.getByTestId("health-guard-error")).toHaveCount(0);
  await expect(page.getByTestId("health-readonly")).toContainText("true");
});

test("an unknown staged capture is refused, not silently replaced by live data", async ({
  page,
}) => {
  await page.goto("/admin?fixture=no-such-capture");
  const notice = page.getByTestId("idp-closed-notice");
  // An unknown capture is the CONSOLE's own input error, so it has its own kind in
  // the one table rather than borrowing "client not found" (which would have shown
  // a title about a client that was never asked about).
  await expect(notice).toHaveAttribute("data-kind", "bad_fixture");
  await expect(page.getByTestId("idp-closed-title")).toHaveText(
    "Unknown staged capture",
  );
  await expect(page.getByTestId("admin-tabs")).toHaveCount(0);
});
