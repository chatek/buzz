import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * VClaw sign-in is the DEFAULT and THE ONLY login method (operator directive 2026-10-03).
 *
 * These tests assert the four measurable claims of that directive, in a real browser:
 *   (a) the FIRST screen's primary action is `Login with VClaw`, with no other forward control;
 *   (b) a completed sign-in never passes through a user-facing key-intro/backup/config/import page —
 *       asserted as a PAGE SEQUENCE, not as "some function was called";
 *   (c) the device key still exists afterwards, and no user action created it;
 *   (d) `Use Back to sign in` is gone, and the community-setup fallback carries the same sign-in.
 *
 * The IdP is scripted at the IPC boundary (`vclaw_oidc_login`), the same boundary the real Tauri app
 * crosses, so everything above the boundary is the shipped code.
 */

/**
 * ⚠️ THE CLAIM GRANTS THE ORG THE FIELD ENTERS, and that is a REQUIREMENT now, not a fixture detail:
 * the org is verified against these groups after the token arrives, and an org the claim does not
 * grant STOPS the flow (the org field's acceptance (d)). So this identity carries BOTH forms of
 * `kuai` (the canonical one is the answer) and the canonical default `vclaw.tenant.vclaw`, which is
 * what the pre-filled `vclaw` must verify against.
 */
const VCLAW_ACCOUNT = {
  subject: "vclaw-subject-1",
  email: "operator@vchat.email",
  preferredUsername: "operator",
  groups: [
    "vclaw.tenant.vclaw",
    "vclaw.tenant.kuai",
    "vchat.tenant.kuai",
    "vchat.admin",
  ],
};

/** The same estate BEFORE the rename: a claim that carries only the LEGACY alias for `kuai`. */
const LEGACY_ACCOUNT = {
  ...VCLAW_ACCOUNT,
  groups: ["vchat.tenant.kuai", "vchat.admin"],
};

/** An org that is well formed and that the estate does NOT grant. */
const UNGRANTED_ORG = "acme-corp";

/** Page signatures, in the order the DOM presented them. */
type PageSignature =
  | "landing"
  | "key-intro"
  | "key-help"
  | "key-import"
  | "backup"
  | "setup"
  | "config"
  | "welcome-setup"
  | "profile"
  | "avatar";

const FORBIDDEN_SEQUENCE: PageSignature[] = [
  "key-intro",
  "key-help",
  "key-import",
  "backup",
  "setup",
  "config",
];

/**
 * Record the page sequence by observing the DOM, not by instrumenting the component.
 *
 * Every onboarding page already carries a page-level marker (`onboarding-page-*`), so the log is
 * built from what was RENDERED. A MutationObserver catches intermediate pages: a page that appears
 * and is immediately replaced still lands in the log, which is exactly what "did not pass through"
 * has to mean.
 */
async function recordPageSequence(page: Page) {
  await page.addInitScript(() => {
    const w = window as typeof window & {
      __VCLAW_PAGE_SEQUENCE__?: string[];
      /** Every distinct `vclaw-org-verdict` text the DOM ever showed, in order. */
      __VCLAW_ORG_VERDICTS__?: string[];
    };
    const log: string[] = [];
    w.__VCLAW_PAGE_SEQUENCE__ = log;
    const verdicts: string[] = [];
    w.__VCLAW_ORG_VERDICTS__ = verdicts;
    const signature = (): string | null => {
      const has = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`) !== null;
      const heading = (text: string) =>
        Array.from(document.querySelectorAll("h1")).some((node) =>
          (node.textContent ?? "").includes(text),
        );
      if (has("welcome-setup")) return "welcome-setup";
      if (has("onboarding-page-key-intro")) return "key-intro";
      if (
        has("onboarding-page-backup") ||
        has("onboarding-page-backup-options")
      )
        return "backup";
      if (has("onboarding-page-download")) return "backup";
      if (has("onboarding-page-2")) return "setup";
      if (has("onboarding-page-config")) return "config";
      if (has("onboarding-page-1") || has("onboarding-page-avatar"))
        return "profile";
      if (heading("Enter your private key") || has("phone-recovery-dialog"))
        return "key-import";
      if (
        Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
          (button) => (button.textContent ?? "").includes("Login with VClaw"),
        )
      )
        return "landing";
      return null;
    };
    const record = () => {
      const next = signature();
      if (next && log[log.length - 1] !== next) log.push(next);
      // THE ESTATE'S ANSWER, captured the same way a page is: the verdict is rendered even when it
      // is immediately replaced (the sign-in mounts the app), and an observer sees what a
      // post-hoc query would miss.
      const verdict = document
        .querySelector('[data-testid="vclaw-org-verdict"]')
        ?.textContent?.trim();
      if (verdict && !verdicts.includes(verdict)) verdicts.push(verdict);
    };
    // `document.documentElement` can still be absent when an init script runs, and a throw there
    // would silently disable the whole recorder — so observe only once it exists.
    const startObserving = () => {
      if (!document.documentElement) {
        window.setTimeout(startObserving, 0);
        return;
      }
      new MutationObserver(record).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      record();
    };
    startObserving();
  });
}

/**
 * Script the IdP at the IPC boundary, ON A LIVE PAGE.
 *
 * The mock bridge installs its own transport from the app's boot path
 * (`main.tsx` → `maybeInstallE2eTauriMocks`), so it REPLACES anything an init script set up. The
 * stub is therefore wrapped around the installed transport after the app has booted, before the
 * click. Everything above the boundary is the shipped code.
 */
async function stubVclawIdp(page: Page, account = VCLAW_ACCOUNT) {
  await page.waitForFunction(
    () =>
      typeof (
        window as typeof window & { __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown }
      ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function",
  );
  await page.evaluate((account: typeof VCLAW_ACCOUNT) => {
    const w = window as typeof window & {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown, options?: unknown) => unknown;
      };
      __BUZZ_E2E_COMMANDS__?: string[];
      __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (
      command: string,
      args?: unknown,
      options?: unknown,
    ) => {
      if (command === "vclaw_oidc_login" || command === "vclaw_oidc_session") {
        w.__BUZZ_E2E_COMMANDS__?.push(command);
        w.__BUZZ_E2E_COMMAND_PAYLOADS__?.push({ command });
        return Promise.resolve(command === "vclaw_oidc_login" ? account : null);
      }
      return original(command, args, options);
    };
  }, account);
}

async function readSequence(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __VCLAW_PAGE_SEQUENCE__?: string[] })
        .__VCLAW_PAGE_SEQUENCE__ ?? [],
  );
}

async function readVerdicts(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __VCLAW_ORG_VERDICTS__?: string[] })
        .__VCLAW_ORG_VERDICTS__ ?? [],
  );
}

async function readCommands(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
}

test("(a) the first screen's primary action is Login with VClaw and nothing else goes forward", async ({
  page,
}) => {
  // ORDER MATTERS: `installMockBridge` installs the IPC transport itself, so the scripted IdP is
  // wrapped around it afterwards. Wrapped earlier, the transport would simply replace the wrapper.
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await recordPageSequence(page);
  await page.goto("/");
  await stubVclawIdp(page);

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();

  const signIn = page.getByRole("button", { name: "Login with VClaw" });
  await expect(signIn).toBeVisible();
  // PRIMARY styling: the landing CTA's chartreuse label on the dark pill.
  await expect(signIn).toHaveCSS("background-color", "rgb(23, 23, 23)");
  await expect(signIn).toHaveCSS("color", "rgb(215, 215, 46)");

  // The upstream methods are not merely unstyled — they are absent.
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use an existing key" }),
  ).toHaveCount(0);
  await expect(page.getByText("Use Back to sign in")).toHaveCount(0);

  // FIRST in DOM order, and the ONLY enabled forward control on the screen.
  const forwardControls = await gate
    .locator("button:enabled")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.textContent?.trim() ?? "")
        .filter((label) => label.length > 0),
    );
  expect(forwardControls[0]).toBe("Login with VClaw");
  expect(forwardControls).toEqual(["Login with VClaw"]);
});

test("(b)+(c) signing in reaches the estate community with no key page, and no user action made the key", async ({
  page,
}) => {
  // ORDER MATTERS: `installMockBridge` installs the IPC transport itself, so the scripted IdP is
  // wrapped around it afterwards. Wrapped earlier, the transport would simply replace the wrapper.
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await recordPageSequence(page);
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await stubVclawIdp(page);

  await page.getByRole("button", { name: "Login with VClaw" }).click();

  // The sign-in leaves the machine gate behind: the app mounts into the community it provisioned.
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);

  // The estate community is present AND active, so the app mounts into it rather than a picker.
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz-communities")),
    )
    .toContain("wss://agents.vclawhub.com");
  const activeCommunityId = await page.evaluate(() =>
    window.localStorage.getItem("buzz-active-community-id"),
  );
  expect(activeCommunityId).not.toBeNull();
  const storedRelay = await page.evaluate(() => {
    const raw = window.localStorage.getItem("buzz-communities") ?? "[]";
    const list = JSON.parse(raw) as Array<{ id: string; relayUrl: string }>;
    return list.find((entry) => entry.relayUrl.includes("agents.vclawhub.com"))
      ?.relayUrl;
  });
  expect(storedRelay).toBe("wss://agents.vclawhub.com");

  // (b) THE PAGE SEQUENCE. Asserted from the DOM the browser actually rendered.
  const sequence = await readSequence(page);
  // A recorder that never installed would make the "no forbidden page" assertion vacuous.
  expect(Array.isArray(sequence)).toBe(true);
  expect(sequence.length).toBeGreaterThan(0);
  console.log("VCLAW PAGE SEQUENCE:", JSON.stringify(sequence));
  expect(sequence[0]).toBe("landing");
  for (const forbidden of FORBIDDEN_SEQUENCE) {
    expect(sequence).not.toContain(forbidden);
  }
  expect(sequence).not.toContain("welcome-setup");

  // (c) the device key still exists, and the subject is recorded BESIDE it (linked, not merged).
  const identity = await page.evaluate(() =>
    window.localStorage.getItem(
      "buzz-machine-onboarding-complete.v2:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ),
  );
  expect(identity).toBe("true");
  const link = await page.evaluate(() =>
    window.localStorage.getItem(
      "buzz-vclaw-link.v1:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ),
  );
  expect(link).not.toBeNull();
  expect(JSON.parse(link ?? "{}")).toMatchObject({
    subject: VCLAW_ACCOUNT.subject,
    email: VCLAW_ACCOUNT.email,
  });

  // (c) no user action created a key: the app READ the identity the Rust layer already holds and
  // never imported, persisted, or exported one.
  const commands = await readCommands(page);
  console.log("VCLAW COMMANDS:", JSON.stringify(commands));
  expect(commands).toContain("vclaw_oidc_login");
  expect(commands).toContain("get_identity");
  expect(commands).not.toContain("import_identity");
  expect(commands).not.toContain("persist_current_identity");
  expect(commands).not.toContain("get_nsec");
});

test("(d) the community-setup fallback carries the sign-in, not 'Use Back to sign in'", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    autoConnectDefaultRelay: true,
    skipCommunitySeed: true,
  });
  await recordPageSequence(page);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz-communities",
      JSON.stringify([
        {
          id: "ws-a",
          name: "Alpha",
          relayUrl: "ws://localhost:3000",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    window.localStorage.setItem("buzz-active-community-id", "ws-a");
  });
  await page.goto("/");
  await expect(page.getByTestId("sidebar-profile-avatar-button")).toBeVisible();
  await stubVclawIdp(page);

  await page.getByTestId("sidebar-profile-avatar-button").click();
  await page.getByTestId("community-switcher").click();
  await page
    .getByRole("menu", { name: "Community actions" })
    .getByRole("menuitem", { name: "Leave community" })
    .click();

  await expect(page.getByTestId("welcome-setup")).toBeVisible();
  await expect(page.getByText("Use Back to sign in")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Login with VClaw" }),
  ).toBeVisible();
  // The gated picker stays gone on the reachable page.
  await expect(page.getByTestId("community-choice-join")).toHaveCount(0);
  await expect(page.getByTestId("community-choice-create")).toHaveCount(0);
  await expect(page.getByTestId("community-choice-existing")).toHaveCount(0);

  await page.getByTestId("welcome-vclaw-sign-in").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz-communities")),
    )
    .toContain("wss://agents.vclawhub.com");
  await expect(page.getByTestId("welcome-setup")).toHaveCount(0);
});

/**
 * ── THE ORG FIELD (operator requirements 2026-10-03) ─────────────────────────────────────────────
 * One field, pre-filled `vclaw`, accepting the keyword the person was given: no selector and no
 * catalogue of the estate's tenants. The local check (required, trimmed, case-folded, length,
 * charset) GATES the button; the ESTATE's claim decides the org immediately after the token arrives,
 * and a miss STOPS the flow before the community is entered.
 */

test("(a) the org field is pre-filled with the default vclaw, and no segment is listed", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await recordPageSequence(page);
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await stubVclawIdp(page);

  const input = page.getByTestId("vclaw-org-input");
  await expect(input).toBeVisible();
  // (a) THE DEFAULT IS SHOWN, never assumed from an empty field.
  await expect(input).toHaveValue("vclaw");
  await expect(page.getByTestId("vclaw-org-prompt")).toHaveAttribute(
    "data-status",
    "ok",
  );
  await expect(page.getByTestId("vclaw-org-sign-in")).toBeEnabled();

  // (b) NO ENUMERATION: nothing that could offer a list of the estate's tenants...
  for (const selector of [
    "select",
    "datalist",
    "option",
    "[role=listbox]",
    "[role=option]",
  ]) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
  // ...and not one org name on the screen before a sign-in.
  const gateText = await page
    .getByTestId("machine-onboarding-gate")
    .innerText();
  expect(gateText).not.toContain("tenant.");
});

test("(c) an empty or invalid org leaves NO next step, and a click cannot advance", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await stubVclawIdp(page);

  const cta = page.getByTestId("vclaw-org-sign-in");
  await page.getByTestId("vclaw-org-input").fill("");
  await expect(page.getByTestId("vclaw-org-prompt")).toHaveAttribute(
    "data-status",
    "invalid",
  );
  await expect(cta).toBeDisabled();
  // THE NO-NEXT-STEP STATE, not the widget: no enabled control remains on the gate at all.
  const enabled = await page
    .getByTestId("machine-onboarding-gate")
    .locator("button:enabled")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.textContent?.trim() ?? "")
        .filter((l) => l.length > 0),
    );
  expect(enabled).toEqual([]);
  // A dispatched click bypasses actionability checks, so this proves the GATE and not the widget.
  await cta.dispatchEvent("click");
  await page.waitForTimeout(250);
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  expect(await readCommands(page)).not.toContain("vclaw_oidc_login");

  // An invalid SHAPE is refused the same way, not just an empty field.
  await page.getByTestId("vclaw-org-input").fill("!!");
  await expect(cta).toBeDisabled();
  await expect(page.getByTestId("vclaw-org-prompt")).toHaveAttribute(
    "data-status",
    "invalid",
  );
});

test("(d) a valid-looking org the estate does NOT grant stops the flow, with the reason", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await recordPageSequence(page);
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await stubVclawIdp(page);

  await page.getByTestId("vclaw-org-input").fill(UNGRANTED_ORG);
  // The local gate PASSES — only the estate can refuse this, and it does so after the token.
  await expect(page.getByTestId("vclaw-org-prompt")).toHaveAttribute(
    "data-status",
    "ok",
  );
  await page.getByTestId("vclaw-org-sign-in").click();

  // THE ESTATE'S REFUSAL, rendered where the field is and MARKED as a stop.
  const verdict = page.getByTestId("vclaw-org-verdict");
  await expect(verdict).toBeVisible();
  await expect(verdict).toHaveAttribute("data-status", "not-granted");
  await expect(verdict).toContainText(
    `did not grant the org "${UNGRANTED_ORG}"`,
  );
  // STATED ONCE: the same reason twice would read as two problems.
  await expect(
    page.getByText(new RegExp(`did not grant the org "${UNGRANTED_ORG}"`)),
  ).toHaveCount(1);
  // NEVER ENTERED THE COMMUNITY: still on the sign-in screen, no community, no key read.
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  const commands = await readCommands(page);
  // The IdP WAS crossed — the check sits after the token, which is the only place the authority is.
  expect(commands).toContain("vclaw_oidc_login");
  // ...and nothing was DONE with it: no key written, no exported key, and the flow never completed.
  // (`get_identity` is NOT asserted on: the app reads its own identity at boot, before any sign-in.)
  expect(commands).not.toContain("persist_current_identity");
  expect(commands).not.toContain("import_identity");
  expect(commands).not.toContain("get_nsec");
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        "buzz-machine-onboarding-complete.v2:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      ),
    ),
  ).toBeNull();
  expect(
    await page.evaluate(() => window.localStorage.getItem("buzz-communities")),
  ).toBeNull();
  const verdicts = await readVerdicts(page);
  expect(verdicts.length).toBe(1);
  expect(verdicts[0]).toContain("did not grant the org");
  // The reason must not blame the IdP: the CLAIM is what said no.
  const gateText = await page
    .getByTestId("machine-onboarding-gate")
    .innerText();
  expect(gateText).not.toContain("vclaw IdP");
  expect(gateText).toContain("no community was entered");
});

test("(e) a granted org proceeds, and the estate's canonical answer is shown", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await recordPageSequence(page);
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await stubVclawIdp(page);

  // Case-folded on the way in, and the answer is the estate's own string for it.
  await page.getByTestId("vclaw-org-input").fill("Kuai");
  await page.getByTestId("vclaw-org-sign-in").click();

  // The app mounts into the community the estate covers...
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  // ...and the ESTATE'S ANSWER was SHOWN on the way, captured from the DOM rather than from state.
  const verdicts = await readVerdicts(page);
  console.log("VCLAW ORG VERDICTS:", JSON.stringify(verdicts));
  expect(verdicts.length).toBe(1);
  expect(verdicts[0]).toContain("vclaw.tenant.kuai");
  expect(verdicts[0]).toContain('"Kuai"');
  // NOT a list: the claim's other groups are never rendered.
  expect(verdicts[0]).not.toContain("vchat.tenant.kuai");
  expect(verdicts[0]).not.toContain("vclaw.tenant.vclaw");
  expect(verdicts[0]).not.toContain("vchat.admin");

  // The answer outlives the screen: it is recorded beside the device key.
  const link = await page.evaluate(() =>
    window.localStorage.getItem(
      "buzz-vclaw-link.v1:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ),
  );
  expect(JSON.parse(link ?? "{}").org).toMatchObject({
    status: "granted",
    entered: "Kuai",
  });
  expect(JSON.parse(link ?? "{}").org.grant.group).toBe("vclaw.tenant.kuai");
});

test("(5) a legacy-only claim still gets in, MARKED as legacy rather than shown as current", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await recordPageSequence(page);
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  // The estate BEFORE the rename: `vchat.tenant.kuai` only. That user is not an empty list...
  await stubVclawIdp(page, LEGACY_ACCOUNT);

  await page.getByTestId("vclaw-org-input").fill("kuai");
  await page.getByTestId("vclaw-org-sign-in").click();
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);

  const verdicts = await readVerdicts(page);
  expect(verdicts.length).toBe(1);
  // ...and the render MARKS it legacy: the alias, the canonical group it should become, the sunset.
  expect(verdicts[0]).toContain('LEGACY alias "vchat.tenant.kuai"');
  expect(verdicts[0]).toContain("vclaw.tenant.kuai");
  expect(verdicts[0]).toContain("2026-11-02");
  expect(verdicts[0]).not.toContain("vchat.admin");
});
