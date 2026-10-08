/**
 * Compact E2E tests for the native private-key copy in ProfileSettingsCard.
 *
 * The settings reveal no longer renders the nsec in the webview
 * (key-lifecycle audit #5): "Copy key" calls `copy_nsec_to_clipboard`, which
 * reads the key and writes the clipboard in Rust. These tests pin that the
 * key text never appears in the DOM and that a failed copy is said out loud.
 */
import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { openSettings } from "../helpers/settings";

/** Expand the identity details section if it is not already open. */
async function expandIdentity(page: import("@playwright/test").Page) {
  const identity = page.getByTestId("profile-identity-card");
  const isOpen = await identity.evaluate(
    (el) => el instanceof HTMLDetailsElement && el.open,
  );
  if (!isOpen) {
    await page.getByTestId("profile-identity-toggle").click();
  }
  await expect(page.getByTestId("profile-identity-details")).toBeVisible();
}

test("copy key calls the native clipboard command and never renders the key", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await openSettings(page, "profile");
  await expandIdentity(page);

  const copyButton = page.getByTestId("profile-private-key-copy");
  await expect(copyButton).toBeVisible();
  await expect(copyButton).toHaveText("Copy key");

  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");

  // The whole point of the native command: no key text is ever in the webview.
  const keyRow = page.getByTestId("profile-private-key-row");
  await expect(keyRow.locator('[data-testid="nsec-value"]')).toHaveCount(0);
});

test("copy key shows error when copy_nsec_to_clipboard fails", async ({
  page,
}) => {
  await installMockBridge(page, { nsecError: "Keychain locked" });
  await page.goto("/");
  await openSettings(page, "profile");
  await expandIdentity(page);

  const copyButton = page.getByTestId("profile-private-key-copy");
  await copyButton.click();

  const error = page.getByTestId("profile-private-key-copy-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("Keychain locked");
});
