/**
 * E2E tests for the two actions in Settings › Profile: **Sign out** (clears the
 * cached vclaw session; key and local data stay) and **Delete my data** (wipes
 * the identity key and all local data, then relaunches).
 *
 * The destructive action is gated behind two explicit steps:
 *   1. backup — check "I have saved my private key"
 *   2. typed confirmation — type the exact phrase "wipe all my data"
 *
 * The sign-out action is NOT gated, because nothing it does needs recovering
 * from — and the first test below asserts that it stays that way, since the two
 * buttons sitting in one section is exactly the arrangement in which they could
 * be collapsed back into one by a later edit.
 */
import { expect, type Page, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { openSettings } from "../helpers/settings";

const CONFIRM_PHRASE = "wipe all my data";

async function openSignOutDialog(page: Page) {
  await openSettings(page, "profile");
  const section = page.getByTestId("settings-signout");
  await section.scrollIntoViewIfNeeded();
  await page.getByTestId("signout-open-dialog").click();
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });
}

test("Sign out clears the vclaw session without the destructive wipe", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await openSettings(page, "profile");

  // The non-destructive control, in the same section, with no confirmation
  // dialog and no typed phrase.
  const signOutButton = page.getByTestId("signout-vclaw");
  await signOutButton.scrollIntoViewIfNeeded();
  await expect(signOutButton).toBeVisible();
  await signOutButton.click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & { __BUZZ_E2E_COMMANDS__?: string[] }
          ).__BUZZ_E2E_COMMANDS__?.includes("vclaw_oidc_sign_out") ?? false,
      ),
    )
    .toBe(true);

  // …and the destructive command was NOT the one that ran.
  const commands = await page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
  expect(commands).not.toContain("sign_out");

  // The identity is still here: the profile card still shows the key actions a
  // wiped app cannot show, and the section still offers both actions.
  await expect(page.getByTestId("signout-open-dialog")).toBeVisible();
  await expect(page.getByTestId("settings-signout")).toContainText("Sign out");
});

test("delete button unlocks only after backup + typed phrase", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await openSignOutDialog(page);

  const deleteButton = page.getByTestId("signout-confirm");
  const backupCheckbox = page.getByTestId("signout-backup-confirm");
  const phraseInput = page.getByTestId("signout-confirm-phrase");

  // Delete is locked initially; the backup checkbox is immediately usable.
  await expect(deleteButton).toBeDisabled();
  await expect(backupCheckbox).toBeEnabled();
  await backupCheckbox.click();

  // Backup alone is not enough.
  await expect(deleteButton).toBeDisabled();

  // Wrong phrase keeps it locked.
  await phraseInput.fill("wipe my data");
  await expect(deleteButton).toBeDisabled();

  // Exact phrase (case/whitespace tolerant) unlocks it.
  await phraseInput.fill(`  ${CONFIRM_PHRASE.toUpperCase()}  `);
  await expect(deleteButton).toBeEnabled();

  // Clearing the phrase locks it again.
  await phraseInput.fill("");
  await expect(deleteButton).toBeDisabled();
});

test("completing both gates invokes sign_out", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await openSignOutDialog(page);

  await page.getByTestId("signout-backup-confirm").click();
  await page.getByTestId("signout-confirm-phrase").fill(CONFIRM_PHRASE);

  const deleteButton = page.getByTestId("signout-confirm");
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & { __BUZZ_E2E_COMMANDS__?: string[] }
          ).__BUZZ_E2E_COMMANDS__?.includes("sign_out") ?? false,
      ),
    )
    .toBe(true);
});

test("cancel resets the gates for the next open", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await openSignOutDialog(page);

  // Satisfy both gates, then cancel.
  await page.getByTestId("signout-backup-confirm").click();
  await page.getByTestId("signout-confirm-phrase").fill(CONFIRM_PHRASE);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();

  // Reopen — everything must be reset again.
  await page.getByTestId("signout-open-dialog").click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByTestId("signout-backup-confirm")).not.toBeChecked();
  await expect(page.getByTestId("signout-confirm-phrase")).toHaveValue("");
  await expect(page.getByTestId("signout-confirm")).toBeDisabled();
});

test("nsec load failure still allows sign-out (backup step degrades)", async ({
  page,
}) => {
  await installMockBridge(page, { nsecError: "Keychain locked" });
  await page.goto("/");
  await openSignOutDialog(page);

  // Error shown in place of the key; checkbox is still usable so the user is
  // not locked out of signing out.
  await expect(page.getByTestId("signout-nsec-error")).toContainText(
    "Keychain locked",
  );
  const backupCheckbox = page.getByTestId("signout-backup-confirm");
  await expect(backupCheckbox).toBeEnabled();

  await backupCheckbox.click();
  await page.getByTestId("signout-confirm-phrase").fill(CONFIRM_PHRASE);
  await expect(page.getByTestId("signout-confirm")).toBeEnabled();
});
