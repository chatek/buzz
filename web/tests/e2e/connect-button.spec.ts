import { expect, test } from "@playwright/test";

/**
 * "Open in Buzz" must never be a silent no-op.
 *
 * MEASURED 2026-09-21 on a machine with no `buzz://` handler (`lsregister -dump |
 * grep -c 'buzz:'` = 0, no Buzz.app): clicking the old control produced NO
 * navigation, NO console message, NO page error, NO dialog, and nothing was
 * rendered to explain it — the URL was identical before and after, and the count of
 * any fallback instruction was 0. That is the failure this asserts against.
 *
 * The component cannot detect scheme registration (no browser exposes it), so it
 * offers the link and then explains what to do if nothing happened. This test pins
 * both halves: the real deep link stays on the anchor, and the explanation — with a
 * copyable link and an honest note about upstream Buzz — is what appears when a
 * machine cannot open it.
 */
test("Open in Buzz explains itself instead of doing nothing", async ({ page }) => {
  await page.goto("/");

  const link = page.locator('a[href^="buzz://"]:visible').first();
  await expect(link).toHaveAttribute("href", /^buzz:\/\/connect\?relay=/);
  // Nothing is shown before the click: a machine WITH a handler never sees the panel.
  await expect(page.getByTestId("buzz-open-fallback")).toHaveCount(0);

  await link.click();

  const panel = page.getByTestId("buzz-open-fallback");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/Nothing happened\?/i);
  await expect(page.getByTestId("buzz-deep-link")).toHaveValue(
    /^buzz:\/\/connect\?relay=/,
  );
  await expect(page.getByTestId("buzz-copy-link")).toBeVisible();
  // The copy stays honest: upstream Buzz does not carry the vclaw sign-in yet, so the
  // panel must not imply a download that would work.
  await expect(panel).toContainText(/no vclaw sign-in yet/i);
});
