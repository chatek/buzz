import { expect, test } from "@playwright/test";

import {
  describeDenyUntilTTL,
  describeEnforcement,
  enforcementUnknownReason,
} from "../../src/features/idp-admin-phase2/phase2-enforcement";
import {
  PHASE2_CONTROLS,
  classifyPhase2Readiness,
  phase2ControlState,
  readinessReason,
} from "../../src/features/idp-admin-phase2/phase2-readiness";
import {
  PHASE2_PATHS,
  IDEMPOTENCY_HEADER,
} from "../../src/features/idp-admin-phase2/phase2-paths";
import type { EnforcementState } from "../../src/features/idp-admin-phase2/phase2-types";

/**
 * THE PHASE-2 INVARIANTS (staged UI, nothing mounted).
 *
 * These tests use NO browser and no page: they import the pure modules and pin
 * the four rules the console must not be "simplified" out of. Each one is
 * written so that the MISLEADING version fails it, not merely so the current
 * version passes:
 *
 *  1. A deny-until-TTL set that this console CANNOT READ reports `entries: null`,
 *     never the payload's `0`. J20 moved the reason and not the rule: the admin
 *     route exists and is NIP-98-protected, so a browser still cannot read it.
 *     "0 revocations" is a claim nobody made (design §6.2), and a renderer that
 *     prints the struct's zero is the exact defect class this lane exists to stop.
 *  2. An unreadable mode stays UNKNOWN. It never becomes "shadow" (a negative
 *     claim about enforcement) and never becomes "enforce" (a positive one).
 *  3. `allowsAreEnforcement` is DERIVED from `available` and `mode`. The copy the
 *     payload sends is compared and REPORTED, never trusted, so a payload that
 *     contradicts its own fields cannot make an allow look enforced.
 *  4. A control is never enabled unless readiness is `ready` and its own
 *     precondition holds, and `501` is not `401`: "not mounted" and "mounted and
 *     refusing everyone" are different facts (design §8).
 */

/**
 * The shape `/api/idp/changes` serves today: the deny-set ADMIN route exists and is
 * NIP-98-protected (J20), and no browser can produce that header - so this console
 * still reports no count, exactly as it did when no route existed.
 */
function enforcementState(over: Partial<EnforcementState>): EnforcementState {
  return {
    source: "loopback /api/authz/shadow",
    available: false,
    mode: "",
    enforcing: false,
    shadow: false,
    would_deny_entries: 0,
    allows_are_enforcement: false,
    deny_until_ttl: {
      available: false,
      exposed_by: "",
      entries: 0,
      note: "the deny set is NIP-98-protected, so no browser can read its count",
    },
    note: "",
    ...over,
  };
}

test("a deny-until-TTL set this console cannot read reports no count, and never the payload's zero", () => {
  const state = enforcementState({
    deny_until_ttl: {
      available: false,
      exposed_by: "",
      entries: 0,
      note: "the deny set is NIP-98-protected, so no browser can read its count",
    },
  });
  const view = describeDenyUntilTTL(state);

  expect(view.available).toBe(false);
  // The payload carries `entries: 0`. Printing that number is the defect.
  expect(view.entries).toBeNull();
  expect(view.entries).not.toBe(0);
  expect(view.sentence).toContain("not zero");
  // J20: the reason moved from "no route exists" to "the route is NIP-98-protected".
  // The ASSERTION moved with it deliberately; the rule it protects did not.
  expect(view.sentence).toContain("NIP-98-protected route");
  expect(view.sentence).toContain("cannot sign a NIP-98 header");

  // And when the surface DOES exist, the count is reported rather than withheld.
  const readable = describeDenyUntilTTL(
    enforcementState({
      deny_until_ttl: {
        available: true,
        exposed_by: "/api/nipfi/deny",
        entries: 4,
        note: "",
      },
    }),
  );
  expect(readable.available).toBe(true);
  expect(readable.entries).toBe(4);

  // An absent payload is not a readable one either.
  expect(describeDenyUntilTTL(null).entries).toBeNull();
});

test("an unreadable mode stays unknown: never shadow, never enforce", () => {
  const unknownStates: (EnforcementState | null)[] = [
    null,
    enforcementState({}),
    enforcementState({ available: true, mode: "junk" }),
    enforcementState({ available: true, mode: " enforce" }),
    enforcementState({ available: true, mode: "ENFORCE" }),
    enforcementState({ available: true, mode: "" }),
  ];

  for (const state of unknownStates) {
    const view = describeEnforcement(state);
    expect(view.allowsAreEnforcement).toBe(false);
    // "Unknown" is not "not shadow": the console must not make either claim.
    expect(view.shadowMode).toBe(false);
    expect(view.headline).toContain("ENFORCEMENT UNKNOWN");
    expect(view.headline).not.toContain("SHADOW MODE");
    expect(view.headline).not.toContain("ENFORCE MODE");
    expect(view.headline).toContain("not an enforcement result");
    expect(enforcementUnknownReason(state).length).toBeGreaterThan(40);
  }
});

test("allowsAreEnforcement is derived from ready/mode, and a disagreeing payload is reported, not trusted", () => {
  const modes = ["shadow", "enforce", "", " enforce", "ENFORCE"];
  for (const available of [true, false]) {
    for (const mode of modes) {
      for (const claim of [true, false]) {
        const state = enforcementState({
          available,
          mode,
          allows_are_enforcement: claim,
        });
        const view = describeEnforcement(state);
        // THE INVARIANT. A payload claiming `true` under shadow does not move it.
        expect(view.allowsAreEnforcement).toBe(
          available === true && mode === "enforce",
        );
        if (!view.allowsAreEnforcement) {
          expect(view.headline).toContain("not an enforcement result");
        } else {
          expect(view.headline).not.toContain("not an enforcement result");
        }
      }
    }
  }

  const liar = describeEnforcement(
    enforcementState({
      available: true,
      mode: "shadow",
      shadow: true,
      allows_are_enforcement: true,
      deny_until_ttl: {
        available: false,
        exposed_by: "",
        entries: 0,
        note: "",
      },
    }),
  );
  expect(liar.allowsAreEnforcement).toBe(false);
  expect(liar.shadowMode).toBe(true);
  expect(liar.payloadDisagrees).toBe(true);

  const honest = describeEnforcement(
    enforcementState({
      available: true,
      mode: "enforce",
      enforcing: true,
      allows_are_enforcement: true,
    }),
  );
  expect(honest.allowsAreEnforcement).toBe(true);
  expect(honest.payloadDisagrees).toBe(false);
});

test("501 is not 401, and no control is enabled without ready and its window", () => {
  expect(
    classifyPhase2Readiness({
      status: 501,
      body: null,
      path: PHASE2_PATHS.changes,
    }),
  ).toBe("absent");
  expect(
    classifyPhase2Readiness({
      status: 401,
      body: '{"error":"restricted: missing Authorization"}',
      path: PHASE2_PATHS.changes,
    }),
  ).toBe("mounted_closed");
  expect(
    classifyPhase2Readiness({
      status: 200,
      body: JSON.stringify({ schema: "idp.changes.v1", changes: [] }),
      path: PHASE2_PATHS.changes,
    }),
  ).toBe("ready");
  // A 200 of the WRONG schema is not readiness, and neither is a dead transport.
  expect(
    classifyPhase2Readiness({
      status: 200,
      body: JSON.stringify({ schema: "idp.clients.v1" }),
      path: PHASE2_PATHS.changes,
    }),
  ).toBe("unknown");
  expect(
    classifyPhase2Readiness({
      status: null,
      body: null,
      transportError: "Failed to fetch",
      path: PHASE2_PATHS.changes,
    }),
  ).toBe("unknown");

  for (const readiness of [
    "absent",
    "mounted_closed",
    "ready",
    "unknown",
  ] as const) {
    expect(readinessReason(readiness).length).toBeGreaterThan(20);
    for (const control of PHASE2_CONTROLS) {
      for (const windowOpen of [false, true]) {
        const view = phase2ControlState(control, readiness, windowOpen);
        expect(view.visible).toBe(
          readiness !== "absent" && readiness !== "unknown",
        );
        expect(view.enabled).toBe(
          readiness === "ready" && (!control.needsWindow || windowOpen),
        );
        if (view.visible && !view.enabled) {
          // A control that is not absent must say why it is dead.
          expect(view.reason.length).toBeGreaterThan(5);
        }
      }
    }
  }

  // The gate is not vacuously closed, and it is not over-open either: for each
  // control, the set of matrix cells that ENABLE it is exactly the set the rule
  // permits. A gate that answered `false` everywhere would pass the loop above
  // and fail here.
  for (const control of PHASE2_CONTROLS) {
    const enabling = (
      ["absent", "mounted_closed", "ready", "unknown"] as const
    ).flatMap((readiness) =>
      [false, true]
        .filter(
          (windowOpen) =>
            phase2ControlState(control, readiness, windowOpen).enabled,
        )
        .map((windowOpen) => `${readiness}/${windowOpen}`),
    );
    expect(enabling).toEqual(
      control.needsWindow ? ["ready/true"] : ["ready/false", "ready/true"],
    );
  }

  expect(IDEMPOTENCY_HEADER).toBe("Idempotency-Key");
  expect(PHASE2_PATHS.applyClient("acme-web")).toBe(
    "/api/idp/clients/acme-web/apply",
  );
});
