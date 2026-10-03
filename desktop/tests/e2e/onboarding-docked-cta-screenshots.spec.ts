import { expect, type Locator, type Page, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

const SHOT_DIR = "test-results/onboarding-docked-cta";
const COMMUNITY_ONBOARDING_TRANSACTION_STORAGE_KEY =
  "buzz-community-onboarding-transaction.v1";
const NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";

test.use({ viewport: { width: 1280, height: 800 } });

async function expectSharedCardGeometry(page: Page, expectedWidth = 610) {
  const geometry = await page
    .getByTestId("onboarding-content-card")
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const styles = window.getComputedStyle(element);
      return {
        borderRadius: styles.borderRadius,
        height: rect.height,
        paddingBottom: styles.paddingBottom,
        paddingLeft: styles.paddingLeft,
        paddingRight: styles.paddingRight,
        paddingTop: styles.paddingTop,
        width: rect.width,
      };
    });

  expect(geometry.width).toBeCloseTo(expectedWidth, 0);
  expect(geometry.height).toBeCloseTo(664, 0);
  expect(geometry.borderRadius).toBe("32px");
  expect(geometry.paddingTop).toBe("48px");
  expect(geometry.paddingRight).toBe("48px");
  expect(geometry.paddingBottom).toBe("48px");
  expect(geometry.paddingLeft).toBe("48px");
}

async function expectUsesFullCardWidth(element: Locator) {
  const geometry = await element.evaluate((node) => {
    const available = node.closest<HTMLElement>(
      ".buzz-onboarding-transition-content",
    );
    if (!available) throw new Error("Onboarding content column is missing");
    const availableBox = available.getBoundingClientRect();
    const elementBox = node.getBoundingClientRect();
    return {
      availableLeft: availableBox.left,
      availableWidth: availableBox.width,
      elementLeft: elementBox.left,
      elementWidth: elementBox.width,
    };
  });
  expect(geometry.elementLeft).toBeCloseTo(geometry.availableLeft, 0);
  expect(geometry.elementWidth).toBeCloseTo(geometry.availableWidth, 0);
}

async function expectProfileFooterMatchesContentGutters(page: Page) {
  const geometry = await page.evaluate(() => {
    const input = document
      .querySelector<HTMLElement>("#onboarding-display-name")
      ?.getBoundingClientRect();
    const back = document
      .querySelector<HTMLElement>('[data-testid="onboarding-back"]')
      ?.getBoundingClientRect();
    const next = document
      .querySelector<HTMLElement>('[data-testid="onboarding-next"]')
      ?.getBoundingClientRect();
    if (!input || !back || !next) {
      throw new Error("Profile controls are missing");
    }
    return {
      backLeft: back.left,
      inputLeft: input.left,
      inputRight: input.right,
      nextRight: next.right,
    };
  });

  expect(geometry.backLeft).toBeCloseTo(geometry.inputLeft, 0);
  expect(geometry.nextRight).toBeCloseTo(geometry.inputRight, 0);
}

async function expectHorizontalCardTransition(
  page: Page,
  pageTestId: string,
  expectedDirection: "forward" | "backward",
) {
  const transition = page
    .getByTestId(pageTestId)
    .locator(".buzz-onboarding-transition-line")
    .first();
  await expect(transition).toHaveAttribute(
    "data-onboarding-direction",
    expectedDirection,
  );

  const motion = await transition.evaluate((line) => {
    const content = line.querySelector<HTMLElement>(
      ":scope > .buzz-onboarding-transition-content",
    );
    if (!content) throw new Error("Onboarding transition content is missing");
    const frame = line.closest<HTMLElement>(".buzz-onboarding-step-frame");
    if (!frame) throw new Error("Onboarding transition frame is missing");

    const animationName = window.getComputedStyle(content).animationName;
    const keyframes: Array<{ transform: string; x: number; y: number }> = [];
    const visitRules = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule && rule.name === animationName) {
          for (const frame of Array.from(rule.cssRules)) {
            const transform = (frame as CSSKeyframeRule).style.transform;
            const matrix = new DOMMatrixReadOnly(transform || "none");
            keyframes.push({
              transform: transform || "none",
              x: matrix.m41,
              y: matrix.m42,
            });
          }
          continue;
        }
        if ("cssRules" in rule) {
          try {
            visitRules((rule as CSSGroupingRule).cssRules);
          } catch {
            // Cross-origin and unsupported grouping rules are irrelevant here.
          }
        }
      }
    };
    for (const styleSheet of Array.from(document.styleSheets)) {
      try {
        visitRules(styleSheet.cssRules);
      } catch {
        // Ignore stylesheets whose rules the browser does not expose.
      }
    }

    const activeFrames = line
      .getAnimations({ subtree: true })
      .flatMap((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect)) return [];
        const target = effect.target;
        return effect
          .getKeyframes()
          .filter((frame) => frame.transform && frame.transform !== "none")
          .map((frame) => {
            const transform = String(frame.transform);
            const matrix = new DOMMatrixReadOnly(transform);
            return {
              target:
                target instanceof HTMLElement
                  ? target.className.toString()
                  : (target?.nodeName ?? "unknown"),
              transform,
              x: matrix.m41,
              y: matrix.m42,
            };
          });
      });

    const frameRect = frame.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const travel = 48;
    const runway = {
      backwardStart: lineRect.left - travel,
      forwardEnd: lineRect.left + content.offsetWidth + travel,
      frameLeft: frameRect.left,
      frameRight: frameRect.right,
    };

    return { activeFrames, animationName, keyframes, runway };
  });

  expect(motion.animationName).toBe(
    `buzz-onboarding-line-slide-${expectedDirection}`,
  );
  expect(motion.keyframes.length).toBeGreaterThanOrEqual(2);
  for (const frame of [...motion.keyframes, ...motion.activeFrames]) {
    expect(
      Math.abs(frame.y),
      `Unexpected vertical motion in ${frame.transform}`,
    ).toBeLessThan(0.01);
  }
  const enteringFrame = motion.keyframes[0];
  if (!enteringFrame) throw new Error("Transition entry frame is missing");
  expect(enteringFrame.x).toBe(expectedDirection === "forward" ? 48 : -48);
  if (expectedDirection === "forward") {
    expect(motion.runway.forwardEnd).toBeLessThanOrEqual(
      motion.runway.frameRight + 0.5,
    );
  } else {
    expect(motion.runway.backwardStart).toBeGreaterThanOrEqual(
      motion.runway.frameLeft - 0.5,
    );
  }
}

test("machine onboarding: the one-door landing, and the withdrawn key pages", async ({
  page,
}) => {
  // ── WHAT THIS TEST USED TO WALK, AND WHY IT NO LONGER CAN ─────────────────────────────────────
  // It used to be the machine flow's screenshot tour: landing -> "Use an existing key" -> the
  // import page -> "Create a new identity key" -> key intro -> the generated-key/backup sheet ->
  // "Download your key" -> setup -> config. The first two of those clicks, and every page after
  // them, are withdrawn by the operator directive of 2026-10-03 ("VClaw sign-in is the DEFAULT and
  // THE ONLY method", and the human must not be walked through handling a device key). The gate is
  // `VCLAW_SIGN_IN_ONLY = true` in src/features/onboarding/ui/MachineOnboardingFlow.tsx: it stops
  // `identity-key-intro`, `identity-key-help`, `key-import` and `backup` from RENDERING, and
  // `vclawSignInOnlyRefusesPage` (read at the initial-page normaliser AND at the `showPage` choke
  // point) stops them being NAVIGATED to as a way to sign in.
  // SO: the tour is replaced by the two claims that are still measurable on this screen — the ONE
  // forward control, and the WITHDRAWAL itself, asserted ABSENT rather than merely unclicked (a
  // stronger statement than the removed clicks ever made). The setup/config half of the tour lives
  // in `machine setup and config: docked CTAs` below, reached by the route that still exists; the
  // withdrawn pages' own geometry and screenshots cannot be asserted anywhere, and the parent's
  // report records that as the coverage this directive removes.
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01-landing.png` });

  // THE ONE FORWARD CONTROL — the thing that replaced both withdrawn buttons.
  const signIn = page.getByRole("button", { name: "Login with VClaw" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toBeEnabled();
  await expect(page.getByTestId("vclaw-org-sign-in")).toBeVisible();

  // WITHDRAWN, ASSERTED ABSENT. `toHaveCount(0)` is the strong form: a CSS hide would satisfy
  // "not visible", but not this.
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use an existing key" }),
  ).toHaveCount(0);
  await expect(page.getByText("Join or create a community")).toHaveCount(0);
  await expect(page.getByTestId("community-choice-join")).toHaveCount(0);
  await expect(page.getByTestId("identity-key-help-trigger")).toHaveCount(0);
  await expect(page.getByTestId("identity-key-help-dialog")).toHaveCount(0);

  // NOT MERELY UNRENDERED — UNREACHABLE. Nothing on this screen navigates to a key page, and the
  // gate refuses the navigation even if it were asked for, so none of the four pages is in the DOM
  // after the screen has settled.
  await waitForAnimations(page);
  await expect(page.getByTestId("onboarding-page-key-intro")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-backup")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-download")).toHaveCount(0);
});

test("machine key import: docked CTA geometry and the recovery sheets", async ({
  page,
}) => {
  // ── WHY THIS TEST BOOTS LOST MODE ─────────────────────────────────────────────────────────────
  // Its old entry was the landing's "Use an existing key" button, which the one-door gate withdrew
  // (measured count: 0). The import SURFACE is not withdrawn — the directive keeps `key-import` and
  // `backup` reachable for an operator whose identity the app reports LOST, which is the app's own
  // recovery entry — and that boot opens DIRECTLY on this page, with the same card, the same input
  // and the same two recovery sheets. Every geometry assertion below is byte-identical to before.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  // The gate, asserted on the way in.
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

  const importCard = page.getByTestId("onboarding-content-card");
  await expect(importCard).toBeVisible();
  await expectSharedCardGeometry(page);
  await expect(page.getByLabel("Private key", { exact: true })).toBeVisible();
  await expectUsesFullCardWidth(page.getByTestId("nostr-import-nsec-input"));
  await expect(importCard).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByTestId("nostr-import-card")).toHaveCount(0);
  await expect(importCard.locator("svg filter")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01b-enter-key.png` });

  await page.getByTestId("nostr-import-file-button").click();
  await expect(page.getByTestId("backup-recovery-dialog")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01c-backup-file-sheet.png` });
  await page.getByRole("button", { name: "Back", exact: true }).click();

  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("phone-recovery-dialog")).toBeVisible();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01d-phone-recovery-sheet.png` });
  await page.getByRole("button", { name: "Back", exact: true }).click();

  await page.getByTestId("nostr-import-nsec-input").fill(NCRYPTSEC);
  await expect(
    page.getByRole("heading", { name: "Unlock your account" }),
  ).toBeVisible();
  await expect(page.getByTestId("backup-password-timeline")).toBeVisible();
  await expect(page.getByTestId("restore-ncryptsec-affordance")).toBeVisible();
  await expect(page.getByTestId("restore-unlock-icon")).toBeVisible();
  await expect(page.getByTestId("nostr-import-passphrase")).toBeFocused();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01e-restore-backup.png` });

  // Back returns to key selection. The old second Back left import for the landing, to click the
  // now-withdrawn "Create a new identity key"; that leg is gone with the button, and the gate it
  // used to walk is asserted above instead.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(importCard).toBeVisible();
});

test("machine key import remains usable in a short viewport", async ({
  page,
}) => {
  // Same fixture change as the geometry test above: the landing's "Use an existing key" is
  // withdrawn, and the lost-mode boot IS the import page. The layout assertions are byte-identical.
  await page.setViewportSize({ width: 900, height: 620 });
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  const heading = page.getByRole("heading", { name: "Enter your private key" });
  const input = page.getByLabel("Private key", { exact: true });
  const footer = page.getByTestId("onboarding-footer-slot");
  await expect(heading).toBeVisible();
  await expect(input).toBeVisible();
  await expect(footer).toBeVisible();

  const layout = await page.evaluate(() => {
    const heading = document.querySelector("h1")?.getBoundingClientRect();
    const input = document
      .querySelector<HTMLInputElement>("#nostr-private-key")
      ?.getBoundingClientRect();
    const footer = document
      .querySelector('[data-testid="onboarding-footer-slot"]')
      ?.getBoundingClientRect();
    return {
      footerTop: footer?.top ?? 0,
      headingBottom: heading?.bottom ?? 0,
      inputBottom: input?.bottom ?? 0,
      inputTop: input?.top ?? 0,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.inputTop).toBeGreaterThan(layout.headingBottom);
  expect(layout.footerTop).toBeGreaterThan(layout.inputBottom);
  expect(layout.scrollHeight).toBeGreaterThanOrEqual(620);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});

test("the withdrawn key-help surface leaves the first-run card contained", async ({
  page,
}) => {
  // ── THE HELP SURFACE IS WITHDRAWN WITH THE KEY STEP IT BELONGED TO ────────────────────────────
  // This test used to walk landing -> key intro -> the in-card "Learn how identity keys work"
  // dialog and prove the dialog stayed inside the onboarding card at a small viewport. The key-intro
  // step and the dialog are withdrawn by the one-door gate (`VCLAW_SIGN_IN_ONLY`; `identity-key-help`
  // is one of the four hidden pages, and the landing no longer renders the dialog at all), so there
  // is no dialog left to measure. The claim is RE-POINTED rather than dropped: the first-run screen
  // that replaced it must stay contained at the same viewport, and the withdrawn surface is asserted
  // ABSENT. The behavioural half of the removal — no trigger, no seen-marker, and the dialog staying
  // gone across a reload — is owned by `identity-key-help.spec.ts`, which is the file for it.
  // MEASURED: the landing is the gate shell itself; it has no `onboarding-content-card` and no
  // `onboarding-step-dots` (those belong to the inner pages), so containment is measured on the
  // gate's own box and on the one forward control inside it.
  await page.setViewportSize({ width: 900, height: 650 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Login with VClaw" }),
  ).toBeVisible();
  await expect(page.getByTestId("vclaw-org-field")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Learn how identity keys work" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("identity-key-help-dialog")).toHaveCount(0);
  await expect(page.getByTestId("identity-key-help-body")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-key-intro")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: `${SHOT_DIR}/02f-first-run-one-door.png`,
  });

  const geometry = await gate.evaluate((element) => {
    const signIn = element.querySelector<HTMLElement>(
      '[data-testid="vclaw-org-sign-in"]',
    );
    const gateBox = element.getBoundingClientRect();
    const signInBox = signIn?.getBoundingClientRect();
    return {
      clientWidth: document.documentElement.clientWidth,
      gateLeft: gateBox.left,
      gateRight: gateBox.right,
      right: signInBox?.right ?? 0,
      signInLeft: signInBox?.left ?? 0,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.gateLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.gateRight).toBeLessThanOrEqual(geometry.clientWidth);
  // The ONE forward control is inside the shell, not hanging off it.
  expect(geometry.signInLeft).toBeGreaterThanOrEqual(geometry.gateLeft);
  expect(geometry.right).toBeLessThanOrEqual(geometry.gateRight);
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
});

test("machine setup and config: docked CTAs", async ({ page }) => {
  // ── THE SETUP AND CONFIG HALF OF THE OLD TOUR, ON THE ROUTE THAT STILL EXISTS ──────────────────
  // This is the second half of the old `machine onboarding: landing, backup, setup docked CTAs`
  // test body, byte-identical from the setup heading onward, with a different ENTRY. The old entry
  // was `onboarding-next` on the generated-key sheet, which is withdrawn; the reachable entry to
  // the setup step is the app's own re-entry: an identity that has already finished machine
  // onboarding but has NO community (`skipCommunitySeed` alone) boots on the gated welcome screen,
  // whose Back action resumes the machine flow at its config step.
  // MEASURED ROUTE: welcome-setup (heading "Sign in to join the estate community") ->
  // `welcome-setup-back` -> `onboarding-page-config` -> `onboarding-back` -> `onboarding-page-2`
  // (heading "Connect your AI provider").
  await installMockBridge(page, undefined, { skipCommunitySeed: true });
  await page.goto("/");

  // The gate is asserted on the way in, not clicked through, and the withdrawn picker is asserted
  // ABSENT (the same pattern the sibling lanes use).
  await expect(
    page.getByRole("heading", {
      name: "Sign in to join the estate community",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Join or create a community")).toHaveCount(0);
  await expect(page.getByTestId("community-choice-join")).toHaveCount(0);
  await expect(page.getByTestId("welcome-vclaw-sign-in")).toBeEnabled();

  await page.getByTestId("welcome-setup-back").click();
  await expect(page.getByTestId("onboarding-page-config")).toBeVisible();
  await page.getByTestId("onboarding-back").click();
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();
  await expectHorizontalCardTransition(page, "onboarding-page-2", "backward");

  // MOVED HERE from the old landing fixture: two claims that fixture can no longer carry, measured
  // on the machine pages instead of dropped.
  //   (1) the docked back control's size — the lost-mode import page the old test measured it on
  //       does not offer a chrome Back at all, so it is measured on the pages that do;
  //   (2) the gate's inner-page chrome: the chartreuse fill keeps the dot grid layered over the
  //       chartreuse -> light-blue gradient, which the landing screen does not have.
  const onboardingBack = page.getByTestId("onboarding-back");
  await expect(onboardingBack).toHaveCSS("width", "52px");
  await expect(onboardingBack).toHaveCSS("height", "52px");
  await expect(onboardingBack.locator("svg")).toHaveCSS("width", "24px");
  await expect(onboardingBack.locator("svg")).toHaveCSS("height", "24px");
  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toHaveCSS(
    "background-image",
    /radial-gradient\(.*\), linear-gradient\(.*rgb\(215, 215, 46\).*rgb\(215, 231, 246\)\)/s,
  );
  await expect(gate).toHaveCSS("color", "rgb(23, 23, 23)");

  await expect(
    page.getByRole("heading", { name: "Connect your AI provider" }),
  ).toBeVisible();
  const subscriptionMethod = page.getByTestId(
    "onboarding-harness-method-subscription",
  );
  const apiMethod = page.getByTestId("onboarding-harness-method-api");
  await expect(subscriptionMethod).toContainText("Log in with a subscription");
  await expect(apiMethod).toContainText("Use an API key");
  await expect(subscriptionMethod).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expectUsesFullCardWidth(subscriptionMethod);
  await expectUsesFullCardWidth(apiMethod);
  await expectSharedCardGeometry(page);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03-setup.png` });

  await page.getByTestId("onboarding-harness-method-subscription").click();
  await expect(
    page.getByRole("heading", { name: "Continue with an AI subscription" }),
  ).toBeVisible();
  await expectHorizontalCardTransition(page, "onboarding-page-2", "forward");
  await expect(page.getByText(/More harnesses can be added in/)).toHaveCount(0);
  await expect(page.getByTestId("onboarding-setup-skip")).toBeVisible();
  await expect(page.getByTestId("onboarding-setup-skip")).toHaveCSS(
    "color",
    "rgb(23, 23, 23)",
  );
  await expect(page.getByTestId("onboarding-setup-next")).toHaveCount(0);
  await expect(
    page.getByText("CLI not detected", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByText("Not installed", { exact: true })).toHaveCount(1);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03b-subscriptions.png` });

  await page.getByTestId("onboarding-runtime-details-codex").click();
  await expect(
    page.getByTestId("onboarding-harness-setup-guide"),
  ).toBeVisible();
  const guideCard = page.getByTestId("onboarding-harness-setup-guide-card");
  await expect(guideCard).toContainText("Codex");
  await expect(guideCard).toContainText(
    "Codex is not detected on this computer.",
  );
  await expect(
    guideCard.getByTestId("onboarding-harness-open-setup-guide"),
  ).toHaveText("Open guide");
  await expect(
    page.getByTestId("onboarding-runtime-install-codex"),
  ).toHaveCount(0);
  await expectHorizontalCardTransition(page, "onboarding-page-2", "forward");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03c-harness-guide.png` });

  await page.getByTestId("onboarding-back").click();
  await expect(
    page.getByRole("heading", { name: "Continue with an AI subscription" }),
  ).toBeVisible();
  await expectHorizontalCardTransition(page, "onboarding-page-2", "backward");
  await page.getByTestId("onboarding-back").click();
  await expect(
    page.getByRole("heading", { name: "Connect your AI provider" }),
  ).toBeVisible();
  await expectHorizontalCardTransition(page, "onboarding-page-2", "backward");
  await page.getByTestId("onboarding-harness-method-api").click();
  await expect(
    page.getByRole("heading", { name: "Connect with an API key" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Choose your provider and enter an API key to connect to the Buzz harness.",
    ),
  ).toBeVisible();
  await expectHorizontalCardTransition(
    page,
    "onboarding-page-config",
    "forward",
  );
  await expect(page.getByTestId("global-agent-default-harness")).toHaveCount(0);
  await expectUsesFullCardWidth(page.getByTestId("global-agent-provider"));
  await expect(page.getByText("Provider", { exact: true })).toHaveCSS(
    "color",
    "rgb(23, 23, 23)",
  );
  await expect(
    page.getByTestId("onboarding-use-different-harness"),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03d-api-buzz-model.png` });

  await page.getByTestId("global-agent-provider").click();
  await page.getByTestId("global-agent-provider-option-anthropic").click();
  await expect(page.getByTestId("persona-provider-api-key")).toBeVisible();
  await expect(
    page.getByText("ANTHROPIC_API_KEY", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("global-agent-model")).toHaveCount(0);
  await expect(
    page.getByTestId("global-agent-thinking-effort-select"),
  ).toHaveCount(0);
  const providerBeforeKey = await page
    .getByTestId("global-agent-provider")
    .boundingBox();
  const apiKeyBeforeKey = await page
    .getByTestId("persona-provider-api-key")
    .boundingBox();
  await waitForAnimations(page);
  await page.screenshot({
    path: `${SHOT_DIR}/03d2-api-provider-selected.png`,
  });

  await page.getByTestId("persona-provider-api-key").fill("sk-test-key");
  await expect(page.getByTestId("global-agent-model")).toHaveText(
    "Claude Opus 4.6",
  );
  const providerAfterKey = await page
    .getByTestId("global-agent-provider")
    .boundingBox();
  const apiKeyAfterKey = await page
    .getByTestId("persona-provider-api-key")
    .boundingBox();
  expect(providerBeforeKey).not.toBeNull();
  expect(apiKeyBeforeKey).not.toBeNull();
  expect(providerAfterKey).not.toBeNull();
  expect(apiKeyAfterKey).not.toBeNull();
  expect(
    Math.abs((providerBeforeKey?.y ?? 0) - (providerAfterKey?.y ?? 0)),
  ).toBeLessThan(2);
  expect(
    Math.abs((apiKeyBeforeKey?.y ?? 0) - (apiKeyAfterKey?.y ?? 0)),
  ).toBeLessThan(2);
  await waitForAnimations(page);
  await page.screenshot({
    path: `${SHOT_DIR}/03d3-api-key-entered.png`,
  });

  await page.getByTestId("onboarding-use-different-harness").click();
  await expect(
    page.getByRole("heading", { name: "Choose a harness" }),
  ).toBeVisible();
  await expectHorizontalCardTransition(page, "onboarding-page-2", "forward");
  await expect(page.getByTestId("onboarding-runtime-buzz-agent")).toContainText(
    "Recommended",
  );
  await expect(
    page.getByTestId("onboarding-runtime-ready-buzz-agent"),
  ).toHaveCount(0);
  await page.getByTestId("onboarding-runtime-buzz-agent").hover();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03e-api-harnesses.png` });

  await page.getByTestId("onboarding-back").click();
  await expect(
    page.getByRole("heading", { name: "Connect with an API key" }),
  ).toBeVisible();
  await expect(page.getByTestId("global-agent-provider")).toHaveText(
    "Anthropic",
  );
  await expect(page.getByTestId("persona-provider-api-key")).toHaveValue(
    "sk-test-key",
  );
  await expectHorizontalCardTransition(
    page,
    "onboarding-page-config",
    "backward",
  );
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/03f-api-return.png` });
});

test("relay onboarding: profile and avatar docked CTAs", async ({ page }) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await expect(page.getByTestId("onboarding-page-1")).toBeVisible();
  await expectSharedCardGeometry(page, 610);
  await expect(page.getByTestId("onboarding-back")).toBeVisible();
  await page.getByTestId("onboarding-display-name").fill("Ada Lovelace");
  await waitForAnimations(page);
  await expectProfileFooterMatchesContentGutters(page);
  await page.screenshot({ path: `${SHOT_DIR}/04-profile.png` });

  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-page-avatar")).toBeVisible();
  await page
    .getByTestId("onboarding-avatar-url")
    .fill("https://example.com/onboarding-avatar.png");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/05-avatar.png` });
});

test("community onboarding: profile and starter-team cards", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await page.addInitScript(
    ({ pubkey, transactionStorageKey }) => {
      window.localStorage.setItem(
        `buzz-machine-onboarding-complete.v2:${pubkey}`,
        "true",
      );
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        transactionStorageKey,
        JSON.stringify({
          id: "screenshot-community-profile",
          source: "first-community",
          stage: "profile",
          relayUrl: "ws://localhost:3000",
          communityName: "Default",
          communityId: "e2e-default-community",
          addedCommunity: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    },
    {
      pubkey: BLANK_TYLER_IDENTITY.pubkey,
      transactionStorageKey: COMMUNITY_ONBOARDING_TRANSACTION_STORAGE_KEY,
    },
  );
  await installMockBridge(
    page,
    { profileHasEvent: false },
    {
      relayWsUrl: "ws://localhost:3000",
      skipOnboardingSeed: true,
    },
  );
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Build your profile" }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-content-card")).toBeVisible();
  await expectSharedCardGeometry(page);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/06-community-profile.png` });

  await page.getByTestId("community-profile-name-key").fill("Ada Lovelace");
  await page.getByTestId("community-profile-next").click();
  await expect(
    page.getByRole("heading", { name: "Meet your starter team" }),
  ).toBeVisible();
  await expectSharedCardGeometry(page);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/07-starter-team.png` });
});
