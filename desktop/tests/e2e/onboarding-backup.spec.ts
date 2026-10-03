import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "@playwright/test";
import { nsecEncode } from "nostr-tools/nip19";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

/**
 * ── THE GENERATED-KEY / BACKUP STEP IS WITHDRAWN, AND NOTHING CAN BRING IT UP ────────────────────
 *
 * WHAT THIS FILE USED TO BE: twelve tests that drove the machine flow's generated-key and backup
 * step — the readable key well and its hover-to-copy treatment, the masked/reveal behaviour of the
 * password-protected download, the 12-character password rule, the test-your-backup dropzone, and
 * the two get_nsec error paths. Every one of them reached that step through
 * `enterMachineBackup` (or the same two clicks inline): the landing's "Create a new identity key",
 * then "Create my private key".
 *
 * WHY THEY CANNOT RUN ANY MORE (operator directive 2026-10-03: "VClaw sign-in is the DEFAULT and THE
 * ONLY method"; the human must not be asked to create, handle, back up or confirm a device key).
 * The gate is `VCLAW_SIGN_IN_ONLY = true` in
 * src/features/onboarding/ui/MachineOnboardingFlow.tsx:
 *   • "Create a new identity key" and "Use an existing key" are NOT RENDERED on the landing
 *     (measured: count 0), so the first click of the old helper cannot happen;
 *   • `vclawSignInOnlyRefusesPage` (read at the initial-page normaliser AND at the `showPage` choke
 *     point) refuses `identity-key-intro` as well, so no card, resumed page, deep link or future
 *     caller can land on it either;
 *   • therefore the `backup` page's ONLY inbound edge — `identity-key-intro` → "Create my private
 *     key" → `showPage("backup", "forward")` — is closed.
 *
 * AND THIS IS MEASURED, NOT READ. The gate keeps a NAMED recovery exception:
 * `VCLAW_SIGN_IN_ONLY_RECOVERY_PAGES = { key-import, backup }` stays reachable "when the app itself
 * reports the identity lost ... that operator still has to recover a key that exists somewhere
 * else". The four tests below walk every live entry point that exists in that state and show the
 * exception for `backup` is not actually reachable in the shipped build:
 *   1. the first-run landing (no key control at all);
 *   2. the empty-community setup step, whose Back control is the ONE remaining caller of
 *      `showPage("backup", "backward")` — refused, because a boot that is not lost has no exception;
 *   3. a lost-mode boot, where importing a key flips the app to `relaunch-required` (the import
 *      path goes to the setup step and the lost flag clears, so `backup` is refused from then on);
 *   4. a recovered identity's setup step (lost mode → phone recovery → setup), same refusal.
 * PRODUCT FINDING for the operator: the recovery exception as written does not reach the backup
 * step, because the only inbound edge is the withdrawn key-intro page and the one edge from the
 * setup step is refused the moment the identity is no longer lost. If a lost-mode operator is
 * supposed to re-import from a key backup FILE, they can — that path lives inside the key-import
 * step ("backup file" → unlock), not on this page.
 *
 * WHAT IS NOT LOST: nothing was deleted from the product — every withdrawn page and control is
 * still in source behind the one constant, and the flow-level claim ("a completed sign-in never
 * passes through a key page") is asserted by `vclawSigninOnly.spec.ts` /
 * `vclaw-signin-only.spec.ts`, with a unit-level twin in
 * src/features/onboarding/ui/vclawSignInOnly.test.mjs.
 *
 * WHAT IS LOST, STATED PLAINLY: the twelve tests' behavioural coverage of the backup UI itself.
 * That coverage cannot be measured while the gate is on — the surface is unreachable by
 * construction — and this lane may not build or edit a product file. The pre-edit file is kept
 * verbatim as `onboarding-backup.spec.ts.withdrawn-coverage.txt` in this lane's handoff directory,
 * and its per-test disposition is in that lane's REPORT.md, so the coverage can be restored with
 * the constant (and this file) when the operator re-opens the method.
 */

/** The backup step's own surfaces: if any of these is in the DOM, the withdrawal is not holding. */
const BACKUP_STEP_TESTIDS = [
  "onboarding-page-backup",
  "onboarding-page-backup-options",
  "onboarding-page-download",
  "backup-key-well",
  "backup-key-value",
  "backup-option-password",
  "backup-passphrase-input",
  "encrypted-backup-create",
  "backup-test-dropzone",
] as const;

async function expectBackupStepAbsent(
  page: import("@playwright/test").Page,
  where: string,
): Promise<void> {
  for (const testId of BACKUP_STEP_TESTIDS) {
    await expect(
      page.getByTestId(testId),
      `${testId} must not exist on ${where}`,
    ).toHaveCount(0);
  }
}

test("the first-run landing offers one door and no way into the generated-key step", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  // The ONE forward control that replaced the two withdrawn buttons.
  const signIn = page.getByRole("button", { name: "Login with VClaw" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toBeEnabled();

  // The old helper's first click, asserted ABSENT — a stronger statement than the click could make.
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use an existing key" }),
  ).toHaveCount(0);

  await expectBackupStepAbsent(page, "the first-run landing");
});

test("the empty-community setup step's Back cannot return to the generated-key step", async ({
  page,
}) => {
  // An identity that has finished machine onboarding but has NO community boots on the gated
  // welcome screen; its Back action is the app's own re-entry into the machine flow, and the setup
  // step it reaches is the ONE remaining caller of `showPage("backup", "backward")`.
  await installMockBridge(page, undefined, { skipCommunitySeed: true });
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Sign in to join the estate community",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByTestId("welcome-setup-back").click();
  await expect(page.getByTestId("onboarding-page-config")).toBeVisible();
  await page.getByTestId("onboarding-back").click();
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();

  // The step that USED to answer to this control. Refused: the page does not change.
  await page.getByTestId("onboarding-back").click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connect your AI provider" }),
  ).toBeVisible();
  await expectBackupStepAbsent(
    page,
    "the setup step reached from the welcome screen",
  );
});

test("a lost-mode import never reaches the generated-key step", async ({
  page,
}) => {
  // The gate's recovery exception: `key-import` IS reachable when the app reports the identity
  // lost. This test walks that path to its end and shows it does not lead to the backup step.
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await expectBackupStepAbsent(page, "the lost-mode import page");

  // Importing the key clears the lost flag, and that boots the app into relaunch-required — so the
  // step the old helper walked to is not on this path either.
  await page
    .getByTestId("nostr-import-nsec-input")
    .fill(nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey)));
  await page.getByTestId("nostr-import-submit").click();
  await expect(page.getByTestId("relaunch-required")).toBeVisible();
  await expectBackupStepAbsent(
    page,
    "the relaunch-required screen after a lost-mode import",
  );
});

test("a recovered identity's setup step cannot return to the generated-key step", async ({
  page,
}) => {
  // The other lost-mode recovery that reaches the setup step: phone pairing. It clears the lost
  // flag through `complete_identity_recovery_pairing`, so the setup step's Back is refused exactly
  // as it is on the welcome path.
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__?.invoke?.(
      "complete_identity_recovery_pairing",
    );
  });

  await expect(
    page.getByRole("heading", { name: "Connect your AI provider" }),
  ).toBeVisible();
  await expect(page.getByTestId("relaunch-required")).toHaveCount(0);

  await page.getByTestId("onboarding-back").click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();
  await expectBackupStepAbsent(
    page,
    "the setup step reached from phone recovery",
  );
});
