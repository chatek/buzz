/**
 * THE DEVICE BINDING, IN THE SIGN-IN IT BELONGS TO (plan `docs/AUTH_BIND_PLAN.md`, jobs A1-A4).
 *
 * Mounted-consumer gates, in the unit suite:
 *   (A1) the bind is crossed ONCE per sign-in, AFTER the OIDC callback and BEFORE anything is
 *        provisioned or mounted — asserted as an ORDER over the IPC commands and the storage writes,
 *        not as "the function exists";
 *   (A2) a bind that does not succeed NEVER reaches `complete()`, and the screen says so;
 *   (A3) neither the failure surface nor the success path asks the person for a key or a code;
 *   (A4) not-bound / revoked / IdP-unreachable / service-unreachable are DISTINCT surfaces;
 *   (T6 at unit level) an unreachable bind is reported, and the app is not rendered at all.
 *
 * The native command is scripted at the IPC boundary — the same boundary the real Tauri app crosses,
 * so everything above it is the shipped code.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

Object.assign(globalThis, {
  // `Element` is not decoration: motion-dom's WAAPI support check reads `Element.prototype.animate`
  // at module scope, and the identity-lost screen dies without it.
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

/** The claim grants the org the field enters, which is a REQUIREMENT of the sequence, not fixture. */
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

/** A bound report, as the native layer returns it. */
const BOUND = {
  outcome: "bound",
  status: 201,
  idempotent: false,
  npub: DEVICE_PUBKEY,
};

/** Every command the flow crossed the IPC boundary with, in order. */
let commands = [];
/** What `buzz-communities` held AT THE MOMENT the bind command was invoked. */
let communitiesAtBind = [];
/** Successive bind answers; the last one repeats. */
let bindAnswers = [BOUND];

function nextBindAnswer() {
  return bindAnswers.length > 1 ? bindAnswers.shift() : bindAnswers[0];
}

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
        return Promise.resolve(VCLAW_ACCOUNT);
      case "vclaw_bind_principal_device": {
        // MEASURE THE ORDER, DO NOT ASSERT THE INTENT: the plan's A1 says the bind must happen
        // BEFORE the first authorised request. The first thing that could make such a request is the
        // app mounting, and the last thing this sequence does before that is provision the estate
        // community — so the storage state at THIS instant is what proves the ordering.
        communitiesAtBind.push(
          dom.window.localStorage.getItem("buzz-communities"),
        );
        const answer = nextBindAnswer();
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      }
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
  communitiesAtBind = [];
  bindAnswers = [BOUND];
  dom.window.localStorage.clear();
  const roots = mountedRoots;
  mountedRoots = [];
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  document.body.innerHTML = "";
});

async function mount({ complete } = {}) {
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
          identityLost: false,
          queryClient,
        }),
      ),
    );
  });
  return container;
}

/** Click a control the way a browser does, and let the sequence settle. */
async function click(container, testId) {
  const button = container.querySelector(`[data-testid="${testId}"]`);
  assert.ok(button, `${testId} must be rendered`);
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function signIn(container) {
  await click(container, "vclaw-org-sign-in");
}

function bindNotice(container) {
  return container.querySelector('[data-testid="vclaw-bind-notice"]');
}

function bindCount() {
  return commands.filter((command) => command === "vclaw_bind_principal_device")
    .length;
}

describe("A1 - the bind happens once, in the right place", () => {
  it("crosses the bind AFTER the IdP and BEFORE anything is provisioned", async () => {
    const completed = [];
    const container = await mount({
      complete: (pubkey, options) => completed.push([pubkey, options]),
    });
    await signIn(container);

    // ONCE. Not twice, not zero: the plan's A1 says "bind once per login, idempotently", and this is
    // the count assertion behind it.
    assert.equal(bindCount(), 1, "the bind must be crossed exactly once");
    // ORDER, over the commands the app actually sent.
    assert.ok(
      commands.indexOf("vclaw_oidc_login") <
        commands.indexOf("vclaw_bind_principal_device"),
      "the bind must follow the OIDC callback",
    );
    assert.ok(
      commands.indexOf("get_identity") <
        commands.indexOf("vclaw_bind_principal_device"),
      "the device key is read before it is bound (the report is checked against it)",
    );
    // BEFORE THE FIRST AUTHORISED REQUEST. The community is provisioned after the bind, so the
    // storage snapshot taken INSIDE the bind call must show no community yet.
    assert.deepEqual(
      communitiesAtBind,
      [null],
      "the bind must happen before the estate community exists",
    );
    // ...and the app was entered exactly once, after all of that.
    assert.deepEqual(completed, [[DEVICE_PUBKEY, { continueToProfile: true }]]);
  });

  it("shows nothing for a bound device, and asks for no key or code", async () => {
    const container = await mount();
    await signIn(container);
    // NEGATIVE CONTROL: a success is not an error surface.
    assert.equal(bindNotice(container), null);
    // A3: no step of the normal flow asks for a key or an invite code — not in the commands, and not
    // in the DOM.
    for (const command of [
      "get_nsec",
      "import_identity",
      "persist_current_identity",
    ]) {
      assert.ok(!commands.includes(command), `${command} must not be crossed`);
    }
    const text = container.textContent ?? "";
    assert.ok(!/invite/i.test(text), "no invite step on this screen");
    assert.ok(!/private key/i.test(text), "no key step on this screen");
    assert.equal(
      container.querySelectorAll('[data-testid^="onboarding-page-"]').length,
      0,
      "no inner page was rendered",
    );
  });
});

describe("A2/T6 - a bind that does not succeed never mounts an empty app", () => {
  it("stops the sequence and SAYS SO when the account service is unreachable", async () => {
    bindAnswers = [
      { outcome: "service_unreachable", reason: "bind_endpoint_unreachable" },
    ];
    const completed = [];
    const container = await mount({
      complete: (pubkey) => completed.push(pubkey),
    });
    await signIn(container);

    const notice = bindNotice(container);
    assert.ok(notice, "the failure must be visible, not silent");
    assert.equal(notice.getAttribute("data-state"), "service-unreachable");
    assert.equal(
      notice.getAttribute("data-reason"),
      "bind_endpoint_unreachable",
    );
    assert.match(notice.textContent ?? "", /unreachable/i);
    // THE POINT OF THE JOB: `complete` is what mounts the app, and it must NOT have been called.
    assert.deepEqual(
      completed,
      [],
      "an unreachable bind must not mount the app (A2)",
    );
    // ...and nothing was provisioned either, so a later retry starts from the same clean state.
    assert.equal(dom.window.localStorage.getItem("buzz-communities"), null);
  });

  it("treats a bind command that does not exist as a state, not as a crash", async () => {
    // This is the shape production has TODAY: J1's shim is not in the binary yet, so the invoke
    // rejects with "command not found". The app must not treat that as success, and must not throw
    // its way past the gate either.
    bindAnswers = [new Error("Unsupported mocked Tauri command")];
    const completed = [];
    const container = await mount({
      complete: (pubkey) => completed.push(pubkey),
    });
    await signIn(container);
    const notice = bindNotice(container);
    assert.ok(notice, "an absent command is still a visible state");
    assert.equal(notice.getAttribute("data-state"), "unreadable");
    assert.deepEqual(completed, []);
  });
});

describe("A4 - the failure states are distinct", () => {
  const CASES = [
    [
      { outcome: "refused", reason: "proof_replayed", status: 401 },
      "not-bound",
    ],
    [{ outcome: "revoked", reason: "device_revoked", status: 401 }, "revoked"],
    [{ outcome: "idp_unreachable" }, "idp-unreachable"],
    [{ outcome: "service_unreachable" }, "service-unreachable"],
  ];

  it("renders a different state and a different heading for each cause", async () => {
    const headings = new Set();
    for (const [answer, state] of CASES) {
      // A fresh page per case: one flow, one sign-in.
      document.body.innerHTML = "";
      bindAnswers = [answer];
      commands = [];
      const container = await mount();
      await signIn(container);
      const notice = bindNotice(container);
      assert.ok(notice, `${state} must be visible`);
      assert.equal(notice.getAttribute("data-state"), state);
      const title = container.querySelector(
        '[data-testid="vclaw-bind-notice-title"]',
      )?.textContent;
      assert.ok(title && title.length > 0);
      headings.add(title);
      // The retry is present on every failure: a state without a way forward is a dead end.
      assert.ok(
        container.querySelector('[data-testid="vclaw-bind-retry"]'),
        `${state} must offer a retry`,
      );
    }
    // THE DISTINCTION ITSELF: four causes, four headings.
    assert.equal(headings.size, CASES.length);
  });

  it("does not blame the IdP for a refusal the account service made", async () => {
    bindAnswers = [
      { outcome: "refused", reason: "proof_replayed", status: 401 },
    ];
    const container = await mount();
    await signIn(container);
    const text = container.textContent ?? "";
    assert.ok(
      !/vclaw IdP/i.test(text),
      "the wrong-layer message this estate keeps paying for",
    );
  });
});

describe("the retry on the failure surface", () => {
  it("re-runs the sequence once, with the same org, and can then succeed", async () => {
    bindAnswers = [
      { outcome: "service_unreachable" },
      { outcome: "already_bound", idempotent: true, npub: DEVICE_PUBKEY },
    ];
    const completed = [];
    const container = await mount({
      complete: (pubkey, options) => completed.push([pubkey, options]),
    });
    await signIn(container);
    assert.equal(bindCount(), 1);
    assert.deepEqual(completed, []);

    await click(container, "vclaw-bind-retry");
    // ONE more attempt — not a storm, and not none.
    assert.equal(bindCount(), 2);
    assert.equal(
      commands.filter((command) => command === "vclaw_oidc_login").length,
      2,
      "the retry re-enters the sequence rather than inventing a second path",
    );
    assert.deepEqual(completed, [[DEVICE_PUBKEY, { continueToProfile: true }]]);
    assert.equal(bindNotice(container), null, "the surface clears once bound");
  });
});
