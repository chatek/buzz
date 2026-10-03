import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * ── THE FIRST-RUN KEY-HELP SURFACE IS GONE BY DESIGN (operator directive 2026-10-03) ─────────────
 *
 * The directive: "VClaw sign-in is the DEFAULT and THE ONLY method", and the user must NOT be
 * walked through creating, importing or handling a device key. The gate that implements it is
 * `VCLAW_SIGN_IN_ONLY` in `MachineOnboardingFlow.tsx`: it stops `identity-key-intro`,
 * `identity-key-help`, `key-import` and `backup` from RENDERING, and `vclawSignInOnlyRefusesPage`
 * (called from the initial-page normaliser AND from `showPage`) stops them being NAVIGATED to, so a
 * card, a resumed page or a deep link cannot reach them either.
 *
 * THIS FILE USED TO ASSERT THE OPPOSITE — and each old assertion now lives somewhere:
 *   1. `identity key help explains the first-run choice` asserted that
 *      `data-testid="identity-key-help-trigger"` revealed itself 2s into the first run, wrote
 *      `buzz.machine-onboarding.identity-key-help-seen.v1`, opened a dialog and survived a reload.
 *      The whole affordance is deliberately removed, so the coverage is INVERTED here (test 1):
 *      the trigger and the dialog are absent from the DOM, and the seen-marker is NEVER written.
 *   2. `identity key help stays readable when the app resolves dark mode` asserted that the help
 *      DIALOG's title kept the light ink under a dark scheme — the dialog pins
 *      `buzz-onboarding-neutral-theme`, because the dark theme otherwise flips `--foreground` to
 *      near-white against its baked-light card. The dialog is unreachable while the gate is on, so
 *      that protection was RE-POINTED at the surface that replaced it (test 2): the first-run
 *      sign-in screen has the same pin, and its ink and CTA are asserted under the same emulated
 *      dark scheme.
 *
 * WHAT IS NOT LOST: the positive one-door flow (the `Login with VClaw` action, the absence of the
 * upstream login buttons, the page sequence with no key page) is covered by
 * `vclaw-signin-only.spec.ts`. That file owns the flow; this file owns the removal.
 *
 * RESTORE: set `VCLAW_SIGN_IN_ONLY` false at the top of `MachineOnboardingFlow.tsx` and the pages
 * come back — restore this file with it, because test 1 asserts the gate is ON.
 */

const HELP_SEEN_KEY = "buzz.machine-onboarding.identity-key-help-seen.v1";
/** The old workaround: the removed affordance revealed itself after this delay. */
const REMOVED_REVEAL_DELAY_MS = 2_000;

test("the first-run screen offers no key help, and never marks the help as seen", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  // The first-run screen is the machine gate, and the one-door sign-in is what it offers instead.
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Login with VClaw" }),
  ).toBeVisible();

  // HIDDEN, NOT MERELY INVISIBLE: neither the trigger nor the dialog is in the DOM at all.
  await expect(page.getByTestId("identity-key-help-trigger")).toHaveCount(0);
  await expect(page.getByTestId("identity-key-help-dialog")).toHaveCount(0);

  // THE MARKER IS THE PROOF THE TIMER IS GONE. Waiting past the old reveal delay is the difference
  // between "not written yet" and "never written" — the removed component was the only writer of
  // this key (grep it: `IDENTITY_KEY_HELP_SEEN_STORAGE_KEY` lives only in IdentityKeyHelpDialog).
  await page.waitForTimeout(REMOVED_REVEAL_DELAY_MS + 1_000);
  await expect(page.getByTestId("identity-key-help-trigger")).toHaveCount(0);
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      HELP_SEEN_KEY,
    ),
  ).toBeNull();

  // And a reload cannot surface it either: the gate, not a first-visit flag, is what removed it.
  await page.reload();
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await expect(page.getByTestId("identity-key-help-trigger")).toHaveCount(0);
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      HELP_SEEN_KEY,
    ),
  ).toBeNull();
});

test("the first-run sign-in screen keeps its light ink when the app resolves dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  // Fresh profiles follow the system scheme, so the emulated dark scheme is the first-run repro:
  // the app resolves the dark theme while onboarding.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();

  // The onboarding shell pins `buzz-onboarding-neutral-theme`, so this screen's ink is the neutral
  // (light) ink even under a dark scheme. Without the pin `--foreground` resolves to near-white and
  // the copy vanishes on the baked-light onboarding card — the same bug class the help-dialog test
  // used to guard, on the surface that replaced it.
  const tagline = gate.locator("p").filter({ hasText: "all in one place" });
  await expect(tagline).toHaveCount(1);
  await expect(tagline).toHaveCSS("color", "rgb(23, 23, 23)");

  // The action keeps its own pair — the chartreuse label on the dark pill — which
  // `vclaw-signin-only.spec.ts` asserts in the light scheme. The pin has to hold for it too.
  const signIn = page.getByRole("button", { name: "Login with VClaw" });
  await expect(signIn).toHaveCSS("background-color", "rgb(23, 23, 23)");
  await expect(signIn).toHaveCSS("color", "rgb(215, 215, 46)");
});
