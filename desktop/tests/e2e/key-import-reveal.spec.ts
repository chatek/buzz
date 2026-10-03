import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SAMPLE_NSEC =
  "nsec1u70xptkumvfc4k4hu0rc4fnzcexvw63zvq2ng9vmqujsaayhparqu8eju9";

test("key import masks the key with a reveal toggle", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // ── WHY THIS TEST BOOTS LOST MODE, AND NOT THE OLD "USE AN EXISTING KEY" CLICK ────────────────
  // DIRECTIVE (operator, "one door", 2026-10-03): "VClaw sign-in is the DEFAULT and THE ONLY
  // method". The gate is `VCLAW_SIGN_IN_ONLY = true` in
  // src/features/onboarding/ui/MachineOnboardingFlow.tsx: it stops `identity-key-intro`,
  // `identity-key-help`, `key-import` and `backup` from RENDERING, and `vclawSignInOnlyRefusesPage`
  // (read at the initial-page normaliser AND at the `showPage` choke point) stops them being
  // NAVIGATED to as a way to sign in. So the landing screen the old fixture rendered no longer
  // carries the "Use an existing key" button this test used to click — measured: its count is 0.
  // WHAT IS *NOT* WITHDRAWN: the import surface itself. The directive keeps `key-import` and
  // `backup` reachable for an operator whose identity the app reports LOST ("that operator still
  // has to recover a key that exists somewhere else"), and that boot opens DIRECTLY on the import
  // page — no click, no card to walk. So the fixture below is the app's own recovery entry, and it
  // is the way a human reaches this input in the shipped build.
  // THE GATE IS ASSERTED ON THE WAY IN (see the three `toHaveCount(0)` assertions): the withdrawn
  // buttons are asserted ABSENT, which is a stronger statement than the removed click ever made.
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  // The lost-mode boot IS the import page: asserted, not clicked through.
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use an existing key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-key-intro")).toHaveCount(0);

  const input = page.getByTestId("nostr-import-nsec-input");
  await expect(input).toBeVisible();
  await waitForAnimations(page);

  // Masked by default; no toggle until there is input. The refreshed card
  // keeps key text on the standard foreground token.
  const toggle = page.getByTestId("nostr-import-reveal-toggle");
  await expect(input).toHaveAttribute("type", "password");
  await expect(toggle).toHaveCSS("opacity", "0");
  await expect(input).toHaveAttribute(
    "class",
    /text-\[oklch\(0\.22213_0_0\)\]/,
  );

  // The toggle is absolutely positioned: its appearance must not resize the
  // input or shift the centered text.
  const widthBefore = await input.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  await input.fill(SAMPLE_NSEC);
  await expect(toggle).toHaveCSS("opacity", "1");
  const widthAfter = await input.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  expect(widthAfter).toBe(widthBefore);

  // Reveal, then clear: a sticky reveal must never carry over to newly
  // pasted content, so the next key starts masked again.
  await toggle.click();
  await expect(input).toHaveAttribute("type", "text");
  await input.fill("");
  await expect(toggle).toHaveCSS("opacity", "0");
  await input.fill(SAMPLE_NSEC);
  await expect(input).toHaveAttribute("type", "password");

  // Re-masking via the toggle still works.
  await toggle.click();
  await expect(input).toHaveAttribute("type", "text");
  await toggle.click();
  await expect(input).toHaveAttribute("type", "password");

  // Narrow viewport: the absolutely positioned toggle must not cause
  // horizontal overflow.
  await page.setViewportSize({ width: 720, height: 620 });
  await waitForAnimations(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
