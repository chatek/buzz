/**
 * Settings › Profile: **Sign out** and **Delete my data** must stay two actions.
 *
 * WHY THIS FILE EXISTS (operator question, 2026-10-03): the section was titled
 * "Sign out" and offered only `Delete my data` — signing out meant destroying the
 * identity key and all local data, or staying signed in. The fix is small and the
 * two actions now look similar on screen, which is exactly why the distinction
 * needs a gate rather than a review: a future edit that wires the safe button to
 * the destructive command would still render a plausible Settings panel.
 *
 * The gates, in the unit suite (Tauri IPC faked at `__TAURI_INTERNALS__`):
 *   (1) `Sign out` clears the vclaw session — the command reports a token existed
 *       and a later session probe finds none — while the identity key is STILL
 *       PRESENT and local data is untouched. Both halves are asserted, because the
 *       difference between the two buttons IS the assertion.
 *   (2) the destructive flow is unchanged: `Delete my data` still wipes and calls
 *       `sign_out`, and never the vclaw command. A control, not a re-test.
 *   (3) the copy no longer promises a sign-out it does not offer, and the
 *       browser-session limitation is on screen.
 *   (4) MUTATION CONTROL: the gate above fails when `Sign out` is wired to the
 *       destructive path — mechanically applied to the real component source.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

Object.assign(globalThis, {
  // `Element` is not decoration: motion-dom's WAAPI support check reads
  // `Element.prototype.animate` at module scope (measured 2026-10-03).
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
// jsdom provides no cancelAnimationFrame at all, and a mounted root's UNMOUNT
// calls it (measured 2026-10-03).
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
// Copy every DOM-level global Radix's AlertDialog focus/dismiss machinery
// references without a `window.` prefix (HTMLInputElement, NodeFilter,
// getComputedStyle, PointerEvent, ...). In bulk, because whack-a-mole per
// missing global is how a dialog test fails with an EMPTY React
// AggregateError — the real error is swallowed and only React's aggregation
// reaches the runner (measured 2026-10-03 on this file).
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (
    !(key in globalThis) &&
    (key.startsWith("HTML") ||
      key.startsWith("SVG") ||
      key.startsWith("CSS") ||
      [
        "Node",
        "NodeFilter",
        "NodeList",
        "NamedNodeMap",
        "Event",
        "CustomEvent",
        "MouseEvent",
        "KeyboardEvent",
        "FocusEvent",
        "InputEvent",
        "PointerEvent",
        "TouchEvent",
        "WheelEvent",
        "EventTarget",
        "Text",
        "Comment",
        "DocumentFragment",
        "Range",
        "Selection",
        "getComputedStyle",
        "IntersectionObserver",
        "ResizeObserver",
      ].includes(key))
  ) {
    const value = dom.window[key];
    if (value !== undefined) globalThis[key] = value;
  }
}
// getComputedStyle must be bound to dom.window or it throws "Illegal invocation".
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
// Radix DismissableLayer and FocusScope dispatch plain objects via
// dispatchEvent for layer-coordination events. jsdom's Event type validation
// throws on those; drop non-Event objects so the dialog's effects do not throw.
// Real Event delivery is untouched.
const originalDispatchEvent = dom.window.EventTarget.prototype.dispatchEvent;
dom.window.EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
  if (!(event instanceof dom.window.Event)) return false;
  return originalDispatchEvent.call(this, event);
};
globalThis.EventTarget = dom.window.EventTarget;

const IDENTITY = {
  pubkey: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  display_name: "npub1mock…",
  storage: "system-keyring",
};
const SIGNOUT_CONFIRM_PHRASE = "wipe all my data";
/** A local-data sentinel: a sign-out must leave it exactly as it was. */
const LOCAL_DATA_KEY = "buzz-communities";
const LOCAL_DATA_VALUE = '[{"id":"e2e-community"}]';

/**
 * The backing service the fake IPC stands in for. Three independent facts, so a
 * test can tell the two buttons apart:
 *
 *   - `vclawSessionLive`      — the cached vclaw credential (what `Sign out` ends)
 *   - `identityPresent`       — the device key (what only `Delete my data` ends)
 *   - `destructiveWipeRan`    — whether the wipe-everything command ran at all
 */
let commands = [];
let vclawSessionLive = false;
let identityPresent = true;
let destructiveWipeRan = false;

const VCLAW_REPORT = {
  hadCachedToken: true,
  tokenCacheRemoved: true,
  revocation: "revoked",
  revocationStatus: 200,
  detail: "revocation returned HTTP 200",
};

globalThis.__TAURI_INTERNALS__ = {
  invoke: (command) => {
    commands.push(command);
    switch (command) {
      case "vclaw_oidc_sign_out": {
        const hadCachedToken = vclawSessionLive;
        vclawSessionLive = false;
        // A NON-destructive sign-out reports the credential it cleared; it must
        // not touch the identity key or any local data.
        return Promise.resolve({ ...VCLAW_REPORT, hadCachedToken });
      }
      case "vclaw_oidc_session":
        return Promise.resolve(
          vclawSessionLive ? { subject: "vclaw-subject-1", groups: [] } : null,
        );
      case "get_identity": {
        if (!identityPresent) {
          return Promise.reject(new Error("identity key is gone"));
        }
        return Promise.resolve(IDENTITY);
      }
      case "get_nsec":
        return Promise.resolve(
          "nsec1mock000000000000000000000000000000000000000000000000000000",
        );
      case "sign_out":
        // The destructive command: wipes the key and local state, then the app
        // relaunches. Modelled here so the two paths are distinguishable.
        destructiveWipeRan = true;
        identityPresent = false;
        vclawSessionLive = false;
        return Promise.resolve();
      default:
        return Promise.reject(new Error(`unmocked: ${command}`));
    }
  },
  transformCallback: () => 1,
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;

let React, act, createRoot;

let mountedRoots = [];

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
});

beforeEach(async () => {
  commands = [];
  vclawSessionLive = false;
  identityPresent = true;
  destructiveWipeRan = false;
  dom.window.localStorage.clear();
  const roots = mountedRoots;
  mountedRoots = [];
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  document.body.innerHTML = "";
});

async function render(Component) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(React.createElement(Component));
  });
  return container;
}

/**
 * Find a control by testid, inside the mounted root OR the document.
 *
 * The document is not laziness: Radix's AlertDialog renders its content in a
 * PORTAL on `document.body`, so the confirmation flow's controls are NOT
 * descendants of the container the component was mounted into (measured
 * 2026-10-03 — looking only inside the container is how an earlier version of
 * this file failed to find the backup checkbox at all).
 */
function node(container, testId) {
  const selector = `[data-testid="${testId}"]`;
  const found =
    container.querySelector(selector) ?? document.querySelector(selector);
  assert.ok(found, `${selector} must be rendered`);
  return found;
}

async function click(container, testId) {
  const target = node(container, testId);
  await act(async () => {
    target.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    // Two macrotask turns: the IPC promise, then the state update it causes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Set an input's value the way a browser does (React reads its own descriptor). */
async function type(container, testId, value) {
  const target = node(container, testId);
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function text(container) {
  return container.textContent ?? "";
}

/**
 * THE GATE. Used by the acceptance test AND by the mutation control, so the
 * mutation control proves *this* gate fails on a destructive wiring rather than
 * some separate, weaker assertion.
 */
function assertSignOutWasNonDestructive() {
  assert.ok(
    commands.includes("vclaw_oidc_sign_out"),
    `Sign out must cross the boundary with vclaw_oidc_sign_out (saw ${JSON.stringify(commands)})`,
  );
  assert.ok(
    !commands.includes("sign_out"),
    `Sign out must NOT run the destructive sign_out (saw ${JSON.stringify(commands)})`,
  );
  assert.equal(destructiveWipeRan, false, "the destructive wipe must not run");
  assert.equal(identityPresent, true, "the identity key must still be present");
  assert.equal(
    vclawSessionLive,
    false,
    "the cached vclaw session must be gone",
  );
  assert.equal(
    dom.window.localStorage.getItem(LOCAL_DATA_KEY),
    LOCAL_DATA_VALUE,
    "local data must be untouched",
  );
}

describe("Sign out is not Delete my data", () => {
  it("(1) Sign out clears the vclaw session and leaves the identity key and local data intact", async () => {
    vclawSessionLive = true;
    dom.window.localStorage.setItem(LOCAL_DATA_KEY, LOCAL_DATA_VALUE);
    const container = await render(
      (await import("./SignOutSection.tsx")).SignOutSection,
    );

    // Preconditions, read through the same boundary the app uses: a session
    // exists, the key exists.
    assert.deepEqual(
      await globalThis.__TAURI_INTERNALS__.invoke("vclaw_oidc_session"),
      { subject: "vclaw-subject-1", groups: [] },
    );
    // (`invoke` records commands; the gate only cares about the click's calls.)
    commands = [];

    await click(container, "signout-vclaw");

    assertSignOutWasNonDestructive();
    // "the command reports a token existed and then none exists"
    assert.equal(VCLAW_REPORT.hadCachedToken, true);
    assert.equal(
      await globalThis.__TAURI_INTERNALS__.invoke("vclaw_oidc_session"),
      null,
      "a session probe after Sign out must find nothing",
    );
    assert.deepEqual(
      await globalThis.__TAURI_INTERNALS__.invoke("get_identity"),
      IDENTITY,
      "the identity key must still be readable after Sign out",
    );
  });

  it("(3) control: Delete my data still wipes and calls sign_out, and never the vclaw command", async () => {
    vclawSessionLive = true;
    dom.window.localStorage.setItem(LOCAL_DATA_KEY, LOCAL_DATA_VALUE);
    const container = await render(
      (await import("./SignOutSection.tsx")).SignOutSection,
    );

    await click(container, "signout-open-dialog");
    await click(container, "signout-backup-confirm");
    await type(container, "signout-confirm-phrase", SIGNOUT_CONFIRM_PHRASE);
    await click(container, "signout-confirm");

    assert.ok(commands.includes("sign_out"), "the wipe must run");
    assert.ok(
      !commands.includes("vclaw_oidc_sign_out"),
      "the destructive action must not touch the vclaw session command",
    );
    assert.equal(destructiveWipeRan, true);
    assert.equal(identityPresent, false, "the wipe removes the identity key");
  });

  it("(3b) control: the wipe stays gated behind backup + typed phrase", async () => {
    const container = await render(
      (await import("./SignOutSection.tsx")).SignOutSection,
    );
    await click(container, "signout-open-dialog");
    assert.equal(node(container, "signout-confirm").disabled, true);
    await click(container, "signout-backup-confirm");
    assert.equal(
      node(container, "signout-confirm").disabled,
      true,
      "backup alone must not unlock the wipe",
    );
    await type(container, "signout-confirm-phrase", "wipe my data");
    assert.equal(node(container, "signout-confirm").disabled, true);
    await type(container, "signout-confirm-phrase", SIGNOUT_CONFIRM_PHRASE);
    assert.equal(node(container, "signout-confirm").disabled, false);
  });

  it("(2)/(4) the copy names the destructive action and states the browser-session limit", async () => {
    const container = await render(
      (await import("./SignOutSection.tsx")).SignOutSection,
    );
    const headings = Array.from(container.querySelectorAll("h2")).map(
      (element) => element.textContent,
    );
    assert.deepEqual(headings, ["Sign out", "Delete my data"]);
    // The safe action is a plain button; the destructive one keeps its variant.
    assert.notEqual(
      node(container, "signout-vclaw").className.includes("destructive"),
      true,
    );
    assert.ok(
      node(container, "signout-open-dialog").className.includes("destructive"),
      "Delete my data must stay visually destructive",
    );
    const note = node(container, "signout-browser-session-note").textContent;
    assert.match(note, /auth\.vclawhub\.com/);
    assert.match(note, /no end-session endpoint/);

    // The confirmation dialog is titled for the destructive action, not for a
    // sign-out.
    await click(container, "signout-open-dialog");
    assert.match(
      text(document.body),
      /Delete your identity key and all data\?/,
      "the dialog must name the destructive action",
    );
    assert.doesNotMatch(text(document.body), /Sign out and wipe all data\?/);
  });

  it("(4) MUTATION CONTROL: wiring Sign out to the destructive path fails the gate", async () => {
    const mutant = writeDestructiveMutant();
    try {
      const { SignOutSection: MutantSection } = await import(mutant.url);

      vclawSessionLive = true;
      dom.window.localStorage.setItem(LOCAL_DATA_KEY, LOCAL_DATA_VALUE);
      const container = await render(MutantSection);
      await click(container, "signout-vclaw");

      assert.ok(
        commands.includes("sign_out"),
        "precondition: the mutant must reach the destructive command",
      );
      assert.throws(
        () => assertSignOutWasNonDestructive(),
        /sign_out/,
        "the gate must fail when Sign out is wired to the destructive path",
      );
    } finally {
      // The mutant lives in the project (so node resolves its bare imports), so
      // it must not be left behind for tsc or a reviewer to find.
      fs.rmSync(mutant.directory, { recursive: true, force: true });
    }
  });
});

/**
 * Mechanically derive a mutant of the REAL component with its sign-out wired to
 * the destructive command, and return its import URL plus its directory.
 *
 * WHERE IT IS WRITTEN, AND WHY: the project root's gitignored `test-results/`
 * scratch directory. Two constraints decide it — a bare `import "react"` only
 * resolves if the mutant sits inside the project (node walks up to
 * `node_modules`), and `tsconfig.json` includes `src` only, so a `.tsx` written
 * under `test-results/` can never fail a typecheck even if a killed test leaves
 * it behind. The relative imports are rewritten to `file:` URLs because the
 * mutant no longer sits beside them.
 *
 * The substitution is asserted to have changed the source, so renaming the
 * import cannot silently turn this control into a no-op.
 */
function writeDestructiveMutant() {
  const sourcePath = path.join(here, "SignOutSection.tsx");
  const original = fs.readFileSync(sourcePath, "utf8");
  const mutated = original.replace(
    'import { vclawSignOut } from "@/shared/api/vclawOidc";',
    'import { signOut as vclawSignOut } from "@/shared/api/tauriIdentity";',
  );
  assert.notEqual(
    mutated,
    original,
    "the mutation must actually rewrite the component's sign-out binding",
  );
  const absolutized = mutated.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (_match, specifier) =>
      `from "${pathToFileURL(resolveSource(path.resolve(here, specifier))).href}"`,
  );
  const parent = path.join(projectRoot(), "test-results", "unit-mutants");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "signout-"));
  const mutantPath = path.join(directory, "SignOutSection.mutant.tsx");
  fs.writeFileSync(mutantPath, absolutized);
  return { url: pathToFileURL(mutantPath).href, directory };
}

/** The desktop project root, however deep this test file is nested. */
function projectRoot() {
  let current = here;
  while (!fs.existsSync(path.join(current, "package.json"))) {
    const parent = path.dirname(current);
    assert.notEqual(parent, current, "no package.json above this test file");
    current = parent;
  }
  return current;
}

/** The loader adds extensions for `./` imports; an absolute URL needs the real one. */
function resolveSource(base) {
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${base}`);
}
