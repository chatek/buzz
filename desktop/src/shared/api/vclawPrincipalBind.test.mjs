/**
 * THE DEVICE-BINDING CLASSIFIER (plan `docs/AUTH_BIND_PLAN.md`, jobs A1/A2/A4).
 *
 * WHY THIS FILE EXISTS AT ALL: the report crosses a boundary whose other side cannot be checked from
 * here, so every claim it makes is read FIELD BY FIELD and anything unrecognised becomes a state the
 * app refuses to act on. This estate has already paid for the other habit once — `vclawOidc.ts`'s
 * `subject`/`sub` mismatch, where a required field read as `undefined` and the symptom was a silently
 * wrong string rather than an error — so the assertions below are as much about what is REFUSED as
 * about what is accepted.
 *
 * Each case names its negative control: the assertion that would FAIL if the classifier had fallen
 * back to a friendlier state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindVclawPrincipalDevice,
  classifyVclawBindError,
  classifyVclawBindReport,
  VCLAW_BIND_COMMAND,
} from "./vclawPrincipalBind.ts";

// `@tauri-apps/api` reaches the IPC transport through `window.__TAURI_INTERNALS__`, so this file
// needs a `window` global even though it renders nothing and touches no document.
globalThis.window ??= globalThis;

const DEVICE = "deadbeef".repeat(8);
const OTHER_DEVICE = "a7".repeat(32);

describe("the bind report is read field by field", () => {
  it("accepts a bound report that agrees with the device it was signed by", () => {
    const report = classifyVclawBindReport(
      { outcome: "bound", status: 201, idempotent: false, npub: DEVICE },
      DEVICE,
    );
    assert.equal(report.state, "bound");
    assert.equal(report.status, 201);
    assert.equal(report.idempotent, false);
    assert.equal(report.npub, DEVICE);
  });

  it("reads an idempotent second bind as bound AND idempotent", () => {
    const report = classifyVclawBindReport(
      { outcome: "already_bound", npub: DEVICE },
      DEVICE,
    );
    assert.equal(report.state, "bound");
    assert.equal(
      report.idempotent,
      true,
      "a second bind writing nothing is reported, not assumed",
    );
    // NEGATIVE CONTROL: an `already_bound` report is NOT a distinct user-visible state. If it were,
    // every returning user would be shown a warning for a no-op.
    assert.equal(report.state === "not-bound", false);
  });

  it("does not require the npub field, but refuses one it cannot read", () => {
    // Absent: nothing to cross-check, and the command takes no arguments, so the device identity is
    // not in question.
    assert.equal(
      classifyVclawBindReport({ outcome: "bound" }, DEVICE).state,
      "bound",
    );
    // `""` is the ADOPTED ENVELOPE's way of saying "no key established" — J1's own response struct
    // documents it — so it reads as absent rather than as a value this layer cannot trust.
    assert.equal(
      classifyVclawBindReport({ outcome: "bound", npub: "" }, DEVICE).state,
      "bound",
    );
    // Present but unreadable: a claim this layer cannot check is not one it stands behind.
    for (const npub of ["npub1qqqq", 42, "DEADBEEF".repeat(8)]) {
      assert.equal(
        classifyVclawBindReport({ outcome: "bound", npub }, DEVICE).state,
        "unreadable",
        `${JSON.stringify(npub)} must not pass as a bound report`,
      );
    }
  });

  it("refuses a success claim that contradicts itself", () => {
    // NEGATIVE CONTROL for the whole "bound" branch: a 5xx beside "bound", or a row written for a
    // DIFFERENT key, must never be admitted as this device's binding. Without these two checks the
    // app would enter the shell on a report that proves nothing.
    assert.equal(
      classifyVclawBindReport({ outcome: "bound", status: 503 }, DEVICE).state,
      "unreadable",
    );
    const mismatched = classifyVclawBindReport(
      { outcome: "bound", status: 200, npub: OTHER_DEVICE },
      DEVICE,
    );
    assert.equal(mismatched.state, "unreadable");
    assert.equal(mismatched.reason, "device_mismatch");
  });

  it("maps each native outcome to its own user-visible state", () => {
    const cases = [
      ["refused", "not-bound"],
      ["revoked", "revoked"],
      ["idp_unreachable", "idp-unreachable"],
      ["service_unreachable", "service-unreachable"],
      ["unreadable", "unreadable"],
    ];
    for (const [outcome, state] of cases) {
      assert.equal(
        classifyVclawBindReport({ outcome }, DEVICE).state,
        state,
        `${outcome} must be its own state`,
      );
    }
    // NEGATIVE CONTROL: the four states are DISTINCT. A4 requires distinct surfaces, and a classifier
    // that collapsed any two of them would satisfy "there is a state" while failing the requirement.
    assert.equal(new Set(cases.map(([, state]) => state)).size, cases.length);
  });

  it("keeps a reason only when it really is a code", () => {
    const kept = classifyVclawBindReport(
      { outcome: "refused", reason: "proof_replayed", status: 401 },
      DEVICE,
    );
    assert.equal(kept.reason, "proof_replayed");
    assert.equal(kept.status, 401);

    // NEGATIVE CONTROL: this value is rendered as an attribute on a failure screen. Anything that is
    // not a short code — prose, a JWT, a bearer value — must be dropped rather than carried through.
    for (const reason of [
      "Proof was replayed: see https://x",
      "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
      "x".repeat(65),
      7,
      null,
    ]) {
      const report = classifyVclawBindReport(
        { outcome: "refused", reason },
        DEVICE,
      );
      assert.equal(report.reason, null, `${reason} must not survive`);
      assert.equal(report.state, "not-bound");
    }
  });

  it("refuses anything it cannot read, and never falls back to a friendly state", () => {
    for (const raw of [
      null,
      undefined,
      "bound",
      42,
      {},
      { outcome: "" },
      { outcome: "BOUND" },
      { outcome: "ok" },
      { outcome: true },
    ]) {
      const report = classifyVclawBindReport(raw, DEVICE);
      assert.equal(
        report.state,
        "unreadable",
        `${JSON.stringify(raw)} must be unreadable`,
      );
      assert.equal(report.outcome, null);
    }
  });

  it("carries the native layer's OWN unreadable verdict, with its reason", () => {
    // The path that exists TODAY: J1 is not deployed, so the estate answers 404 and the native layer
    // reports `unreadable` with `endpoint_absent`. The state must be the same conservative one, and
    // the reason must survive — a code is what support reads.
    const report = classifyVclawBindReport(
      { outcome: "unreadable", reason: "endpoint_absent", status: 404 },
      DEVICE,
    );
    assert.equal(report.state, "unreadable");
    assert.equal(report.outcome, "unreadable");
    assert.equal(report.reason, "endpoint_absent");
    assert.equal(report.status, 404);
    // NEGATIVE CONTROL: an unreadable verdict is not a refusal and not a success.
    assert.notEqual(report.state, "not-bound");
    assert.notEqual(report.state, "bound");
  });

  it("keeps a refusal a refusal even when the estate names the proven key", () => {
    // J1's lane states it: on a refusal `npub` may be the PROVEN key even though nothing was written.
    // The key is not a claim that a row exists — the outcome and the idempotent flag are — so this
    // must stay a refusal and must not be upgraded by the presence of a well-formed npub.
    const report = classifyVclawBindReport(
      {
        outcome: "refused",
        reason: "binding_exists",
        status: 409,
        npub: DEVICE,
      },
      DEVICE,
    );
    assert.equal(report.state, "not-bound");
    assert.equal(report.npub, DEVICE);
    assert.equal(report.idempotent, false);
    // The gate this feeds: the only state that enters the app is `bound`.
    assert.notEqual(report.state, "bound");
  });

  it("reads a rejected invocation as 'we have no answer', not as a guessed fault", () => {
    const report = classifyVclawBindError();
    assert.equal(report.state, "unreadable");
    // NEGATIVE CONTROL: the free-text message from the native layer is NOT classified. Guessing
    // "the endpoint is down" out of it would be a claim this layer cannot support.
    assert.equal(report.state === "service-unreachable", false);
  });

  it("returns that state instead of throwing, so no caller can fall through", async () => {
    const previous = globalThis.__TAURI_INTERNALS__;
    globalThis.__TAURI_INTERNALS__ = {
      invoke: () => Promise.reject(new Error("command not found")),
      transformCallback: () => 1,
    };
    try {
      const report = await bindVclawPrincipalDevice(DEVICE);
      assert.equal(report.state, "unreadable");
      assert.equal(report.reason, "command_unavailable");
    } finally {
      globalThis.__TAURI_INTERNALS__ = previous;
    }
  });

  it("crosses the boundary with the command name and NO arguments", async () => {
    const previous = globalThis.__TAURI_INTERNALS__;
    const calls = [];
    globalThis.__TAURI_INTERNALS__ = {
      invoke: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ outcome: "bound", npub: DEVICE });
      },
      transformCallback: () => 1,
    };
    try {
      const report = await bindVclawPrincipalDevice(DEVICE);
      assert.equal(report.state, "bound");
      assert.deepEqual(
        calls.map((call) => call.command),
        [VCLAW_BIND_COMMAND],
      );
      // THE CREDENTIAL POSTURE, ASSERTED: neither the access token nor the NIP-98 proof is built
      // here, so neither can travel in this direction. An argument added to this call would have to
      // be a credential, and this assertion is what makes that a failing test rather than a code
      // review note.
      assert.deepEqual(calls[0].args, {});
    } finally {
      globalThis.__TAURI_INTERNALS__ = previous;
    }
  });
});
