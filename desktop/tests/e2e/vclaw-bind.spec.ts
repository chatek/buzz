import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * T3 AND T6 OF THE AUTH-BIND PLAN (`docs/AUTH_BIND_PLAN.md`) — the app half.
 *
 * T3  fresh install -> sign in -> agents visible, no operator action.
 * T6  the bind endpoint unreachable -> the app says so and does not render empty.
 *
 * ── WHAT IS SCRIPTED, AND WHY THAT IS THE RIGHT SEAM ────────────────────────────────────────────
 * The device binding crosses ONE boundary: `vclaw_bind_principal_device`, a native command that owns
 * the OIDC access token and the NIP-98 proof so that neither reaches the webview
 * (`src/shared/api/vclawPrincipalBind.ts` states the contract). The tests script that boundary — the
 * same boundary `vclaw-signin-only.spec.ts` already scripts the IdP at — so everything ABOVE it is
 * the shipped code: the sequence, the ordering, the gate, and every word of the failure surface.
 *
 * ⚠ WHAT THESE TESTS DO NOT PROVE, stated rather than implied: that J1 (`POST
 * /v1/principal/device/bind`) exists, that the native command exists, or that the token + proof are
 * accepted by the estate. Those are the backend lane's and the native shim's, and until they land the
 * app's real answer to this call is a rejection — which is the `unreadable` case below, and it is
 * asserted rather than assumed away.
 *
 * ⚠ NO TIMEOUT IS WIDENED ANYWHERE IN THIS FILE, and every absence is asserted POSITIVELY
 * (`toHaveCount(0)`), so "the app did not render an empty estate" is a measurement and not a wait.
 */

const AGENT = "a7".repeat(32);
const DEVICE_PUBKEY = "deadbeef".repeat(8);
const ESTATE_RELAY = "wss://agents.vclawhub.com";

/** The claim grants the org the field enters — a REQUIREMENT of the sequence, not a fixture detail. */
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

const BOUND = {
  outcome: "bound",
  status: 201,
  idempotent: false,
  npub: DEVICE_PUBKEY,
};

type BindAnswer = Record<string, unknown> | { error: string };

/**
 * Script the vclaw boundary: the IdP, and the device bind.
 *
 * Installed AFTER `page.goto` and AFTER any early `vclaw_oidc_session` probe, because
 * `installMockBridge` replaces the transport from the app's own boot path — a stub installed before
 * that would simply be discarded (the same ordering note `vclaw-signin-only.spec.ts` carries).
 */
async function scriptVclawBoundary(
  page: Page,
  options: { bindAnswers?: BindAnswer[] } = {},
) {
  await page.waitForFunction(
    () =>
      typeof (
        window as typeof window & { __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown }
      ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function",
  );
  await page.evaluate(
    ({ bindAnswers, account }) => {
      const w = window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: unknown,
            options?: unknown,
          ) => unknown;
        };
        __BUZZ_E2E_COMMANDS__?: string[];
        __VCLAW_BIND_CALLS__?: number;
      };
      w.__VCLAW_BIND_CALLS__ = 0;
      const answers = bindAnswers ?? [];
      let index = 0;
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (command, args, ipcOptions) => {
        if (
          command === "vclaw_oidc_login" ||
          command === "vclaw_oidc_session"
        ) {
          w.__BUZZ_E2E_COMMANDS__?.push(command);
          return Promise.resolve(
            command === "vclaw_oidc_login" ? account : null,
          );
        }
        if (command === "vclaw_bind_principal_device") {
          // COUNTED, so "bind once per login" is a number in this file rather than a claim.
          w.__VCLAW_BIND_CALLS__ = (w.__VCLAW_BIND_CALLS__ ?? 0) + 1;
          w.__BUZZ_E2E_COMMANDS__?.push(command);
          const answer = answers[Math.min(index, answers.length - 1)];
          index += 1;
          // No answer scripted: the command does not exist, which is what production does TODAY.
          if (!answer) {
            return Promise.reject(
              new Error(
                "Unsupported mocked Tauri command: vclaw_bind_principal_device",
              ),
            );
          }
          if (typeof answer === "object" && "error" in answer) {
            return Promise.reject(new Error(String(answer.error)));
          }
          return Promise.resolve(answer);
        }
        return original(command, args, ipcOptions);
      };
    },
    { bindAnswers: options.bindAnswers, account: VCLAW_ACCOUNT },
  );
}

function readBindCalls(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __VCLAW_BIND_CALLS__?: number })
        .__VCLAW_BIND_CALLS__ ?? 0,
  );
}

function readCommands(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
}

/** The machine landing, with the sign-in reachable and the gate still up. */
async function gotoGate(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
}

/**
 * The app's OWN profile step, when the mock relay carries no kind:0 for this identity. It is not a
 * key step and not a code step (A3), and the tests below assert exactly that before walking it.
 */
async function completeProfileStep(page: Page) {
  await page.getByTestId("onboarding-display-name").fill("Robin");
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-page-avatar")).toBeVisible();
  // The avatar step's own "Skip for now" — the product's affordance, and one more page that asks for
  // no key and no code.
  await page.getByTestId("onboarding-skip").click();
}

/**
 * A3, as an assertion: no surface on this page asks a person for a KEY or an INVITE CODE. Both are
 * the estate's old identity steps, and both must stay out of the normal flow.
 */
async function expectNoKeyOrCodeStep(page: Page) {
  for (const testId of [
    "onboarding-page-key-intro",
    "onboarding-page-backup",
    "onboarding-page-backup-options",
    "onboarding-page-download",
    "nostr-import-nsec-input",
    "phone-recovery-dialog",
    "backup-recovery-dialog",
  ]) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use an existing key" }),
  ).toHaveCount(0);
  await expect(page.getByText(/invite code/i)).toHaveCount(0);
}

/** The app itself: the shell, and the estate community it was provisioned with. */
async function expectAppShell(page: Page) {
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz-communities")),
    )
    .toContain(ESTATE_RELAY);
}

test("[auth-bind T3] fresh state: sign in, and the estate's agents are visible", async ({
  page,
}) => {
  // A FRESH INSTALL: no seeded community, no seeded onboarding completion, and no kind:0 for this
  // identity — so the app's own profile step is walked too, and the test has to prove that step asks
  // for no key and no code (A3) rather than assume it.
  await installMockBridge(
    page,
    {
      managedAgents: [
        { name: "Estuary Scout", pubkey: AGENT, status: "running" },
      ],
      profileHasEvent: false,
    },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await gotoGate(page);
  await scriptVclawBoundary(page, { bindAnswers: [BOUND] });
  await expectNoKeyOrCodeStep(page);

  // THE ONE HUMAN ACTION THIS TEST IS ABOUT. No invite code, no key, no operator involvement.
  await page.getByRole("button", { name: "Login with VClaw" }).click();

  // The app's own profile step — NOT a binding step, and it offers no key or code either.
  await expect(page.getByTestId("onboarding-page-1")).toBeVisible();
  await expectNoKeyOrCodeStep(page);
  await completeProfileStep(page);

  // THE CLAIM: a non-empty app. The shell mounts, into the estate community, and the account's own
  // agent is on screen — with nothing else asked of the person.
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  await expectAppShell(page);
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId(`managed-agent-${AGENT}`)).toBeVisible();
  await expect(page.getByTestId("agents-page-content")).toBeVisible();

  // ONCE PER LOGIN, and no failure surface anywhere.
  expect(await readBindCalls(page)).toBe(1);
  await expect(page.getByTestId("vclaw-bind-notice")).toHaveCount(0);
  const commands = await readCommands(page);
  expect(commands).toContain("vclaw_bind_principal_device");
  for (const forbidden of [
    "get_nsec",
    "import_identity",
    "persist_current_identity",
  ]) {
    expect(commands).not.toContain(forbidden);
  }
});

test("[auth-bind T3] a supported profile reaches its agents with the sign-in as the ONLY action", async ({
  page,
}) => {
  // The same claim with the variable removed: the identity already has a profile, so the sign-in is
  // the ONLY interaction between a fresh install and the agent list. Nothing else is clicked — so
  // this is the cleanest reading of A1's "no operator action" that the product allows.
  await installMockBridge(
    page,
    {
      managedAgents: [
        { name: "Estuary Scout", pubkey: AGENT, status: "running" },
      ],
      profileHasEvent: true,
    },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await gotoGate(page);
  await scriptVclawBoundary(page, { bindAnswers: [BOUND] });

  await page.getByRole("button", { name: "Login with VClaw" }).click();

  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  await expectAppShell(page);
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId(`managed-agent-${AGENT}`)).toBeVisible();
  expect(await readBindCalls(page)).toBe(1);
  await expectNoKeyOrCodeStep(page);
});

test("[auth-bind T6] an unreachable bind endpoint is reported, and the estate is not rendered empty", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      managedAgents: [
        { name: "Estuary Scout", pubkey: AGENT, status: "running" },
      ],
      profileHasEvent: true,
    },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await gotoGate(page);
  await scriptVclawBoundary(page, {
    bindAnswers: [
      { outcome: "service_unreachable", reason: "bind_endpoint_unreachable" },
    ],
  });

  await page.getByRole("button", { name: "Login with VClaw" }).click();

  // THE APP SAYS SO. A state, a reason code and a retry — all three, in the browser.
  const notice = page.getByTestId("vclaw-bind-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-state", "service-unreachable");
  await expect(notice).toHaveAttribute(
    "data-reason",
    "bind_endpoint_unreachable",
  );
  await expect(page.getByTestId("vclaw-bind-notice-title")).toContainText(
    "unreachable",
  );
  await expect(page.getByTestId("vclaw-bind-retry")).toBeEnabled();

  // AND IT DOES NOT RENDER AN EMPTY ESTATE — asserted POSITIVELY, on every surface the empty app
  // would have shown. This is the defect A2 exists to remove, so its absence is the assertion.
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("home-inbox-list")).toHaveCount(0);
  await expect(page.getByTestId("open-agents-view")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-1")).toHaveCount(0);
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  // ...and the agent this account owns is NOT on screen either. This is the sharp form of the
  // assertion: the agent EXISTS in the estate (it is seeded), so "no agent card" is not vacuous —
  // it is the app refusing to show a shell it has not been authorised for.
  await expect(page.getByTestId("agents-page-content")).toHaveCount(0);
  await expect(page.getByTestId(`managed-agent-${AGENT}`)).toHaveCount(0);
  // Nothing was provisioned either, so the next attempt starts where this one did.
  expect(
    await page.evaluate(() => window.localStorage.getItem("buzz-communities")),
  ).toBeNull();

  // THE RETRY IS THE WAY FORWARD, and it takes the same door: the same boundary, re-scripted with an
  // accepting answer, so the retry proves the app can get past this — not merely that a button
  // exists.
  await scriptVclawBoundary(page, { bindAnswers: [BOUND] });
  await page.getByTestId("vclaw-bind-retry").click();
  await expect(page.getByTestId("vclaw-bind-notice")).toHaveCount(0);
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  await expectAppShell(page);
});

test("[auth-bind T6] an endpoint that is not deployed is reported, never read as success", async ({
  page,
}) => {
  // THE SHAPE PRODUCTION HAS TODAY, now that the native command EXISTS
  // (`desktop/src-tauri/src/commands/vclaw_principal_bind.rs`) and J1 does not: the estate answers
  // 404 for the path, the native layer reports `unreadable` with `endpoint_absent`, and the app must
  // say it could not confirm the binding rather than mount a shell it is not authorised for.
  await installMockBridge(
    page,
    { profileHasEvent: true },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await gotoGate(page);
  await scriptVclawBoundary(page, {
    bindAnswers: [
      { outcome: "unreadable", reason: "endpoint_absent", status: 404 },
    ],
  });

  await page.getByRole("button", { name: "Login with VClaw" }).click();

  const notice = page.getByTestId("vclaw-bind-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-state", "unreadable");
  await expect(notice).toHaveAttribute("data-reason", "endpoint_absent");
  await expect(page.getByTestId("vclaw-bind-retry")).toBeVisible();
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("home-inbox-list")).toHaveCount(0);
});

test("[auth-bind T6] a bind call that yields NO report is still a visible state", async ({
  page,
}) => {
  // The other shape of "no usable answer": the invoke itself rejects (a build whose command is not
  // registered, a transport-level failure of the IPC bridge). The app must not treat that as
  // success and must not throw its way past the gate.
  await installMockBridge(
    page,
    { profileHasEvent: true },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await gotoGate(page);
  await scriptVclawBoundary(page, { bindAnswers: [] });

  await page.getByRole("button", { name: "Login with VClaw" }).click();

  const notice = page.getByTestId("vclaw-bind-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-state", "unreadable");
  await expect(page.getByTestId("vclaw-bind-retry")).toBeVisible();
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("home-inbox-list")).toHaveCount(0);
});

test("[auth-bind A4] a revoked device and an unreachable service are DIFFERENT surfaces", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { profileHasEvent: true },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await gotoGate(page);
  await scriptVclawBoundary(page, {
    bindAnswers: [
      { outcome: "revoked", reason: "device_revoked", status: 401 },
    ],
  });
  await page.getByRole("button", { name: "Login with VClaw" }).click();

  const notice = page.getByTestId("vclaw-bind-notice");
  await expect(notice).toHaveAttribute("data-state", "revoked");
  await expect(notice).toHaveAttribute("data-reason", "device_revoked");
  const revokedTitle = await page
    .getByTestId("vclaw-bind-notice-title")
    .innerText();
  const revokedBody = await page
    .getByTestId("vclaw-bind-notice-body")
    .innerText();
  // The revoked state says what to do about it, and it is not the same thing as waiting for a
  // service: the retry is a SIGN-IN, which is what the copy promises.
  await expect(page.getByTestId("vclaw-bind-retry")).toHaveText(
    "Sign in again",
  );
  // THE CAUSE IS NAMED, in the body — where the copy puts the reason ("The binding for this device
  // was revoked"). The HEADING is the action ("signed out of your account"), and asserting on the two
  // SEPARATELY is what keeps this honest: a first version of this test pinned "revoked" to the title
  // and failed, because the copy deliberately leads with what happened to the person, not with the
  // estate's word for it.
  expect(revokedBody).toContain("revoked");
  // NEGATIVE CONTROL: it is NOT the unreachable-service surface, and it must not blame the IdP for a
  // refusal the account service made (the wrong-layer failure the pitfall log carries).
  expect(revokedTitle).not.toContain("unreachable");
  const gateText = await page
    .getByTestId("machine-onboarding-gate")
    .innerText();
  expect(gateText).not.toContain("vclaw IdP");
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
});
