/**
 * THE FAILED-BIND COPY, AS A SET (plan `docs/AUTH_BIND_PLAN.md`, jobs A2 and A4).
 *
 * Two claims are worth a test rather than a reading:
 *   (a) every state a bind can fail in has its OWN heading and its own retry label — A4 asks for
 *       "distinct error surfaces", and a table that mapped two states to one string would satisfy
 *       "there is an error message" while failing the requirement;
 *   (b) every failure says that NOTHING HAS LOADED. That is A2's whole point: the app must not leave
 *       an empty screen that a person reads as an empty account.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeUnstampedBindWarning,
  describeVclawBindFailure,
  describeVclawBindState,
  isUnstampedBind,
  vclawBindEntersApp,
} from "./vclawBindCopy.ts";

const STATES = [
  "bound",
  "not-bound",
  "revoked",
  "idp-unreachable",
  "service-unreachable",
  "unreadable",
];

describe("the bind copy", () => {
  it("writes every state, with a distinct heading", () => {
    const titles = STATES.map((state) => describeVclawBindState(state).title);
    for (const title of titles) {
      assert.equal(typeof title, "string");
      assert.ok(
        title.length > 0,
        "a state without a heading is a silent state",
      );
    }
    // NEGATIVE CONTROL: distinct states must not share a heading, or the screen cannot be told apart
    // from the screen for a different cause — the wrong-layer failure mode A4 exists to prevent.
    assert.equal(new Set(titles).size, STATES.length);
  });

  it("lets the app be entered only when the device is bound", () => {
    for (const state of STATES) {
      assert.equal(
        vclawBindEntersApp({
          state,
          outcome: null,
          reason: null,
          status: null,
          idempotent: false,
          npub: null,
        }),
        state === "bound",
        `${state} must ${state === "bound" ? "" : "not "}enter the app`,
      );
    }
  });

  it("gives every failure a control that says what it will do", () => {
    for (const state of STATES) {
      const copy = describeVclawBindState(state);
      if (state === "bound") {
        assert.equal(
          copy.retryLabel,
          "",
          "there is nothing to retry after a success",
        );
        continue;
      }
      assert.ok(
        copy.retryLabel.length > 0,
        `${state} is a dead end without a retry`,
      );
    }
  });

  it("says 'nothing has loaded' in every failure, so no screen reads as an empty account", () => {
    for (const state of STATES) {
      const copy = describeVclawBindState(state);
      if (state === "bound") continue;
      assert.match(
        copy.body,
        /nothing has loaded/i,
        `${state} must not read as an empty estate (A2)`,
      );
    }
  });

  it("composes the one-line form from the SAME copy the screen renders", () => {
    const state = "revoked";
    const copy = describeVclawBindState(state);
    const line = describeVclawBindFailure({
      state,
      outcome: "revoked",
      reason: "device_revoked",
      status: 401,
      idempotent: false,
      npub: null,
    });
    assert.equal(line, `${copy.title}. ${copy.body}`);
    // NEGATIVE CONTROL: the reason code is NOT interpolated into the sentence a person reads. It is
    // the backend's string, and this layer does not vouch for it.
    assert.ok(!line.includes("device_revoked"));
  });

  it("flags a bound-but-unstamped bind without failing it", () => {
    const bound = {
      state: "bound",
      outcome: "bound",
      reason: null,
      status: 201,
      idempotent: false,
      npub: null,
      npubStamped: false,
    };
    assert.equal(isUnstampedBind(bound), true);
    // NEGATIVE CONTROL: the stamp verdict must not change whether the app enters — a bound device
    // enters whether or not the stamp landed. It only changes WHAT the app says.
    assert.equal(vclawBindEntersApp(bound), true);
    // "Not stated" and "stamped" are both clean — only an explicit `false` is the warning.
    assert.equal(isUnstampedBind({ ...bound, npubStamped: true }), false);
    assert.equal(isUnstampedBind({ ...bound, npubStamped: null }), false);
    // The warning names the consequence, not just the fact.
    assert.match(describeUnstampedBindWarning(), /cannot administer channels/i);
    assert.match(describeUnstampedBindWarning(), /re-bind/i);
  });
});
