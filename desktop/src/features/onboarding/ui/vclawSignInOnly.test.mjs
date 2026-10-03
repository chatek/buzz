/**
 * VClaw sign-in is the DEFAULT and THE ONLY login method (operator directive 2026-10-03).
 *
 * Mounted-consumer gates, in the unit suite:
 *   (a) the first screen offers `Login with VClaw` as its ONLY forward control;
 *   (b) completing the sign-in renders NO user-facing key-intro/backup/config/import page — asserted
 *       as a page sequence recorded from the DOM, not as "some function was called";
 *   (c) the device key exists afterwards and no user action created it;
 *   (d) the upstream create/import buttons are absent, and the hidden pages are REFUSED even when a
 *       caller navigates straight at one (the gate, not the render).
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

Object.assign(globalThis, {
  // `Element` is not decoration: motion-dom's WAAPI support check reads `Element.prototype.animate`
  // at module scope, and without it the identity-lost test dies with "Element is not defined"
  // (measured 2026-10-03 — the only pre-existing failure in this file).
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  self: dom.window,
  window: dom.window,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
dom.window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
// ...and its partner, which jsdom does not provide at all: the screens animate (LandingBees drives
// its own rAF loop) and a mounted root's UNMOUNT calls cancelAnimationFrame. Without it the cleanup
// throws "cancelAnimationFrame is not defined" the moment a root is unmounted.
dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
dom.window.ResizeObserver = globalThis.ResizeObserver;
dom.window.matchMedia ??= (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
globalThis.matchMedia = dom.window.matchMedia;

const DEVICE_PUBKEY =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
/**
 * ⚠️ THE CLAIM GRANTS THE ORG THE FIELD ENTERS, and that is now a REQUIREMENT rather than a fixture
 * detail: the org the human enters is verified against these groups after the token arrives, and an
 * org the claim does not grant STOPS the flow (operator requirement 2026-10-03; acceptance (d)).
 * This identity therefore carries BOTH forms of `kuai` (canonical and legacy, so the canonical one
 * is the answer) and the canonical default `vclaw.tenant.vclaw`, which is what the pre-filled
 * `vclaw` must verify against.
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

/** Every command the flow crossed the IPC boundary with, in order. */
let commands = [];
let signedIn = 0;
/** What the scripted IdP answers with; a test may swap it (the legacy-alias case does). */
let idpAccount = VCLAW_ACCOUNT;

globalThis.__TAURI_INTERNALS__ = {
  invoke: (command) => {
    commands.push(command);
    switch (command) {
      case "get_identity":
        return Promise.resolve({
          pubkey: DEVICE_PUBKEY,
          display_name: "npub1mock…",
          storage: "system-keyring",
        });
      case "vclaw_oidc_session":
        return Promise.resolve(null);
      case "vclaw_oidc_login":
        signedIn += 1;
        return Promise.resolve(idpAccount);
      case "vclaw_bind_principal_device":
        // THE SEQUENCE GREW A STEP (job A1, `docs/AUTH_BIND_PLAN.md`): the device binding now sits
        // between the device key and the community, so this file has to script it at the same IPC
        // boundary it already scripts the IdP at. A BOUND answer only — this file's claims are about
        // which PAGES the sign-in renders, and the bind's own failure states are covered by
        // `vclawBindGate.test.mjs`.
        return Promise.resolve({
          outcome: "bound",
          status: 201,
          idempotent: false,
          npub: DEVICE_PUBKEY,
        });
      default:
        return Promise.reject(new Error(`unmocked: ${command}`));
    }
  },
  transformCallback: () => 1,
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;

let React,
  act,
  createRoot,
  QueryClient,
  QueryClientProvider,
  MachineOnboardingFlow;

/**
 * Every root this file mounted, so `beforeEach` can UNMOUNT them.
 *
 * WHY: a mounted-but-detached root is not harmless here. These screens drive motion's frame loop,
 * and node's jsdom has no real rAF (the shim is a 0 ms timer), so a leaked root leaves a loop that
 * the NEXT test's `act()` has to drain — which is how a suite that passes in 3 s turns into a
 * 60 s timeout. Unmounting is what makes each case independent.
 */
let mountedRoots = [];

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  ));
  ({ MachineOnboardingFlow } = await import("./MachineOnboardingFlow.tsx"));
});

beforeEach(async () => {
  commands = [];
  signedIn = 0;
  idpAccount = VCLAW_ACCOUNT;
  dom.window.localStorage.clear();
  const roots = mountedRoots;
  mountedRoots = [];
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  document.body.innerHTML = "";
});

/** Page signatures, recorded from the DOM by a MutationObserver. */
const FORBIDDEN = [
  "onboarding-page-key-intro",
  "onboarding-page-backup",
  "onboarding-page-backup-options",
  "onboarding-page-download",
  "onboarding-page-2",
  "onboarding-page-config",
  "phone-recovery-dialog",
  "backup-recovery-dialog",
];

function watchPages() {
  const seen = [];
  const record = () => {
    for (const id of FORBIDDEN) {
      if (
        document.querySelector(`[data-testid="${id}"]`) &&
        !seen.includes(id)
      ) {
        seen.push(id);
      }
    }
    const heading = Array.from(document.querySelectorAll("h1")).some((node) =>
      (node.textContent ?? "").includes("Enter your private key"),
    );
    if (heading && !seen.includes("key-import-heading")) {
      seen.push("key-import-heading");
    }
  };
  const observer = new dom.window.MutationObserver(record);
  observer.observe(document.body, { childList: true, subtree: true });
  return { seen, stop: () => observer.disconnect(), record };
}

async function mount({ complete, identityLost = false, initialPage } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(MachineOnboardingFlow, {
          complete: complete ?? (() => {}),
          continueWithIdentity: () => {},
          continueWithRecoveredIdentity: () => {},
          identityLost,
          initialPage,
          queryClient,
        }),
      ),
    );
  });
  return container;
}

/** Everything the flow rendered, as text: what a person would actually read. */
function renderedText(container) {
  return container.textContent ?? "";
}

/**
 * Set the org field the way a browser does. React reads the value through its own descriptor, so a
 * plain `input.value = ...` is invisible to it and the change would be discarded.
 */
async function setOrgInput(container, value) {
  const input = container.querySelector('[data-testid="vclaw-org-input"]');
  assert.ok(input, "the org field must be rendered");
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

/** Click the field's CTA — the only forward control on the screen while the gate is on. */
async function clickSignIn(container) {
  const button = container.querySelector('[data-testid="vclaw-org-sign-in"]');
  assert.ok(button, "the org field's CTA must be rendered");
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function enabledButtonLabels(container) {
  return Array.from(container.querySelectorAll("button"))
    .filter((button) => !button.disabled)
    .map((button) => (button.textContent ?? "").trim())
    .filter((label) => label.length > 0);
}

describe("vclaw sign-in is the only method", () => {
  it("(a) the first screen's only forward control is Login with VClaw", async () => {
    const container = await mount();
    assert.deepEqual(enabledButtonLabels(container), ["Login with VClaw"]);
    assert.equal(
      container.querySelectorAll('[data-testid="onboarding-page-key-intro"]')
        .length,
      0,
      "the create-a-key page must not be the entry",
    );
  });

  it("(d) the upstream create-key and import-key buttons are absent", async () => {
    const container = await mount();
    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    assert.ok(!labels.includes("Create a new identity key"));
    assert.ok(!labels.includes("Use an existing key"));
  });

  it("(b)+(c) signing in renders no key page and hands the EXISTING device key on", async () => {
    const completed = [];
    const container = await mount({
      complete: (pubkey, options) => completed.push([pubkey, options]),
    });
    const pages = watchPages();
    const [signIn] = Array.from(container.querySelectorAll("button"));
    await act(async () => {
      signIn.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    pages.record();
    pages.stop();

    assert.equal(signedIn, 1, "the IdP is crossed exactly once");
    // (b) the page sequence: no key-intro / backup / config / import page ever rendered.
    assert.deepEqual(pages.seen, []);
    // (c) the key was READ, never created by a user action.
    assert.ok(commands.includes("get_identity"));
    assert.ok(!commands.includes("import_identity"));
    assert.ok(!commands.includes("persist_current_identity"));
    assert.ok(!commands.includes("get_nsec"));
    // ...and the flow hands that key on, so the app mounts under the identity it already had.
    assert.deepEqual(completed, [[DEVICE_PUBKEY, { continueToProfile: true }]]);
  });

  it("(b) the sign-in leaves the estate community active and the subject linked beside the key", async () => {
    await mount();
    const container = document.body;
    const [signIn] = Array.from(container.querySelectorAll("button"));
    await act(async () => {
      signIn.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const communities = JSON.parse(
      dom.window.localStorage.getItem("buzz-communities") ?? "[]",
    );
    assert.deepEqual(
      communities.map((entry) => entry.relayUrl),
      ["wss://agents.vclawhub.com"],
    );
    assert.equal(
      dom.window.localStorage.getItem("buzz-active-community-id"),
      communities[0].id,
    );
    const link = JSON.parse(
      dom.window.localStorage.getItem(`buzz-vclaw-link.v1:${DEVICE_PUBKEY}`) ??
        "null",
    );
    assert.deepEqual(link?.subject, VCLAW_ACCOUNT.subject);
    assert.deepEqual(link?.email, VCLAW_ACCOUNT.email);
  });

  it("(d) a caller that navigates straight at a hidden page lands on the sign-in instead", async () => {
    // The gate is not the render: `initialPage` is exactly how a resumed page or a future caller
    // arrives, and the normaliser must refuse it.
    const container = await mount({ initialPage: "backup" });
    assert.equal(
      container.querySelectorAll('[data-testid^="onboarding-page-"]').length,
      0,
    );
    assert.deepEqual(enabledButtonLabels(container), ["Login with VClaw"]);
  });

  it("(d) an identity-lost boot still reaches the recovery page — that is not a login method", async () => {
    const container = await mount({
      identityLost: true,
      initialPage: "key-import",
    });
    const heading = container.querySelector("h1")?.textContent ?? "";
    assert.match(heading, /Enter your private key/);
  });
});

/**
 * THE ORG FIELD (operator requirements 2026-10-03, acceptance (a)–(e)).
 *
 * One field, pre-filled `vclaw`, accepting the keyword the person was given: no selector, no
 * catalogue of the estate's tenants. Validation GATES progress locally (shape only); the ESTATE's
 * claim decides whether the org is granted, immediately after the token arrives — and a miss stops
 * the flow before the community is entered.
 */
describe("the org field", () => {
  it("(a) the org field is pre-filled with the default vclaw, and the CTA is reachable", async () => {
    const container = await mount();
    const input = container.querySelector('[data-testid="vclaw-org-input"]');
    assert.ok(input, "the org field must be on the sign-in screen");
    assert.equal(
      input.value,
      "vclaw",
      "the default is SHOWN, never assumed from an empty field",
    );
    const prompt = container.querySelector('[data-testid="vclaw-org-prompt"]');
    assert.equal(
      prompt.getAttribute("data-status"),
      "ok",
      "the default is accepted, so there is a next step",
    );
    assert.equal(
      container.querySelector('[data-testid="vclaw-org-sign-in"]').disabled,
      false,
    );
  });

  it("(b) NO list of segments is rendered anywhere — a door, not a catalogue", async () => {
    const container = await mount();
    for (const selector of [
      "select",
      "datalist",
      "option",
      "[role=listbox]",
      "[role=option]",
    ]) {
      assert.equal(
        container.querySelectorAll(selector).length,
        0,
        `the field must not offer ${selector}: listing the estate's tenants exposes who it serves`,
      );
    }
    // Before any sign-in, not one org name is on the screen.
    assert.ok(
      !renderedText(container).includes("tenant."),
      "the field must render no org name of its own",
    );

    // After a GRANTED sign-in, exactly the ONE org the estate answered with is rendered — the other
    // groups in the same claim are not.
    await setOrgInput(container, "kuai");
    await clickSignIn(container);
    const text = renderedText(container);
    assert.ok(
      text.includes("vclaw.tenant.kuai"),
      "the estate's own answer is shown",
    );
    assert.ok(
      !text.includes("vclaw.tenant.vclaw"),
      "no other segment of the claim is listed",
    );
    assert.ok(
      !text.includes("vchat.admin"),
      "operator scope is not rendered as an org",
    );
  });

  it("(c) an empty or invalid keyword has NO next step, and a click cannot advance", async () => {
    const container = await mount();
    const prompt = container.querySelector('[data-testid="vclaw-org-prompt"]');
    for (const invalid of ["", "   ", "x", "!!", "a".repeat(64)]) {
      await setOrgInput(container, invalid);
      assert.equal(
        prompt.getAttribute("data-status"),
        "invalid",
        `"${invalid}" must be refused`,
      );
      // THE NO-NEXT-STEP STATE, not the widget: with an invalid entry there is no enabled control
      // on this screen at all...
      assert.deepEqual(
        enabledButtonLabels(container),
        [],
        `"${invalid}" must leave no next step`,
      );
      // ...and a click that reaches the handler anyway still cannot cross the IPC boundary.
      await clickSignIn(container);
      assert.equal(signedIn, 0, `"${invalid}" must not reach the IdP`);
    }
    assert.ok(!commands.includes("vclaw_oidc_login"));
    // ...and the CTA comes back the moment the entry is valid again: the gate is the VALUE, not a
    // one-way lock.
    await setOrgInput(container, "vclaw");
    assert.deepEqual(enabledButtonLabels(container), ["Login with VClaw"]);
  });

  it("(d) a valid-looking keyword the estate does not grant STOPS the flow, and says why", async () => {
    const completed = [];
    const container = await mount({
      complete: (pubkey, options) => completed.push([pubkey, options]),
    });
    await setOrgInput(container, "acme-corp");
    assert.equal(
      container
        .querySelector('[data-testid="vclaw-org-prompt"]')
        .getAttribute("data-status"),
      "ok",
      "the shape check passes — only the ESTATE can refuse this one",
    );
    await clickSignIn(container);

    // The refusal comes AFTER the token, which is the only place the authority exists.
    assert.equal(signedIn, 1);
    const text = renderedText(container);
    assert.match(text, /did not grant the org "acme-corp"/);
    assert.match(text, /no community was entered/);
    assert.ok(!/vclaw IdP/.test(text), "an org refusal must not blame the IdP");
    // STATED ONCE. The same reason rendered twice reads as two problems.
    assert.equal(
      text.split(`did not grant the org "acme-corp"`).length - 1,
      1,
      "the reason must be rendered exactly once",
    );

    // THE ESTATE'S ANSWER, as a STOP: the verdict element carries the refusal and its status.
    const verdict = container.querySelector(
      '[data-testid="vclaw-org-verdict"]',
    );
    assert.ok(verdict, "the estate's refusal is shown where the field is");
    assert.equal(verdict.getAttribute("data-status"), "not-granted");
    assert.match(verdict.textContent, /did not grant the org "acme-corp"/);

    // NOTHING ADVANCED: no key read, no community written, the app not entered.
    assert.deepEqual(completed, []);
    assert.ok(!commands.includes("get_identity"));
    assert.equal(dom.window.localStorage.getItem("buzz-communities"), null);
    assert.equal(
      dom.window.localStorage.getItem("buzz-active-community-id"),
      null,
    );
    // Still on the sign-in screen, with the CTA reachable to try the right name.
    assert.deepEqual(enabledButtonLabels(container), ["Login with VClaw"]);
  });

  it("(e) a granted keyword proceeds, and the estate's canonical answer is shown", async () => {
    const completed = [];
    const container = await mount({
      complete: (pubkey, options) => completed.push([pubkey, options]),
    });
    await setOrgInput(container, "Kuai");
    await clickSignIn(container);

    const verdict = container.querySelector(
      '[data-testid="vclaw-org-verdict"]',
    );
    assert.ok(
      verdict,
      "the estate's answer must be rendered, not just asserted",
    );
    assert.equal(verdict.getAttribute("data-status"), "granted");
    assert.match(
      verdict.textContent,
      /vclaw\.tenant\.kuai/,
      "the estate's own string",
    );
    assert.match(
      verdict.textContent,
      /"Kuai"/,
      "BOTH the entry and the answer are shown",
    );
    assert.match(verdict.textContent, /granted/);
    assert.ok(
      !/vchat\.tenant\.kuai/.test(verdict.textContent),
      "the alias is not the answer here",
    );

    // ...and it still hands the EXISTING device key on, exactly as before the field existed.
    assert.deepEqual(completed, [[DEVICE_PUBKEY, { continueToProfile: true }]]);
    // THE ANSWER OUTLIVES THE SCREEN: it is recorded beside the key, so a later session can read it.
    const link = JSON.parse(
      dom.window.localStorage.getItem(`buzz-vclaw-link.v1:${DEVICE_PUBKEY}`) ??
        "null",
    );
    assert.equal(link.org.status, "granted");
    assert.equal(link.org.grant.group, "vclaw.tenant.kuai");
    assert.equal(link.org.entered, "Kuai");
  });

  it("(5) a LEGACY-only claim still renders its org, MARKED as legacy rather than current", async () => {
    // The same estate before the rename: the claim carries only `vchat.tenant.kuai`.
    idpAccount = LEGACY_ACCOUNT;
    const completed = [];
    const container = await mount({
      complete: (pubkey, options) => completed.push([pubkey, options]),
    });
    await setOrgInput(container, "kuai");
    await clickSignIn(container);

    const verdict = container.querySelector(
      '[data-testid="vclaw-org-verdict"]',
    );
    assert.ok(verdict, "a legacy-only identity is not an empty list");
    assert.equal(verdict.getAttribute("data-status"), "legacy");
    assert.match(verdict.textContent, /LEGACY alias "vchat\.tenant\.kuai"/);
    assert.match(
      verdict.textContent,
      /vclaw\.tenant\.kuai/,
      "the canonical group is named",
    );
    assert.match(
      verdict.textContent,
      /2026-11-02/,
      "the sunset date is stated",
    );
    assert.ok(!renderedText(container).includes("vchat.admin"));
    assert.deepEqual(completed, [[DEVICE_PUBKEY, { continueToProfile: true }]]);
  });
});
