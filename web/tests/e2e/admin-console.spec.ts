import { expect, test, type Page } from "@playwright/test";

import { forbiddenSingleTotalsIn } from "../../src/features/admin/consent-classification";
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
 *  3. THE RULE THAT MATTERS: no text node anywhere on the page pairs a number
 *     with the word "consent(s)". The scanner is the one the feature exports,
 *     and it is proven able to FAIL by injecting "281 consents" into the page.
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

  // THE RULE.
  expect(await forbiddenConsentTotals(page)).toEqual([]);
});

test("the forbidden-total scanner can fail (control)", async ({ page }) => {
  await page.goto(`/admin?fixture=${LIVE_FIXTURE}&tab=consent`);
  expect(await forbiddenConsentTotals(page)).toEqual([]);

  // Inject exactly the phrase the rule forbids and require the scanner to catch
  // it. A guard that cannot fail proves nothing about the page it passed.
  const texts = await renderedTextNodes(page, "281 consents");
  expect(forbiddenSingleTotalsIn(texts)).toEqual(["281 consents"]);
  expect(forbiddenSingleTotalsIn(["Consent (281)"])).toHaveLength(1);
  expect(forbiddenSingleTotalsIn(["total consents"])).toHaveLength(1);
  expect(
    forbiddenSingleTotalsIn([
      "never answered — the consent screen was shown and no response was recorded",
    ]),
  ).toEqual([]);
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

  expect(await forbiddenConsentTotals(page)).toEqual([]);
});

test("a refused read is 'Not authorized yet', never an empty table", async ({
  page,
}) => {
  await page.route("**/api/idp/clients", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: "restricted: no principal (no npub -> principal registry yet)",
        delivery: "fail-closed",
      }),
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
    "restricted: no principal",
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
  await expect(notice).toHaveAttribute("data-kind", "not_found");
  await expect(notice).toContainText("Unknown staged capture");
  await expect(page.getByTestId("admin-tabs")).toHaveCount(0);
});
