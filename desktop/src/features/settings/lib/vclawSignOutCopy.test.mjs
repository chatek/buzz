/**
 * The four things a user can be told after a sign-out, and the one that must
 * never read as a clean success.
 *
 * WHY (operator question, 2026-10-03): the local session is cleared in every one
 * of these verdicts, so a single "Signed out." string would be true and
 * misleading at once — the difference is whether the refresh token at the IdP was
 * actually revoked. The two verdicts that leave it live (`rejected`,
 * `unreachable`) are the ones a person might act on by walking away from a
 * borrowed machine, so they are asserted by name, and they are the ones
 * `isRevocationUnresolved` must flag for the warning toast.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeVclawSignOut,
  isRevocationUnresolved,
} from "./vclawSignOutCopy.ts";

function report(overrides = {}) {
  return {
    hadCachedToken: true,
    tokenCacheRemoved: true,
    revocation: "revoked",
    revocationStatus: 200,
    detail: null,
    ...overrides,
  };
}

describe("vclaw sign-out copy", () => {
  it("reports an accepted revocation by its consequence, not as a verified kill", () => {
    const copy = describeVclawSignOut(report());
    assert.match(copy, /cleared on this device/);
    assert.match(copy, /accepted the revocation/);
    // The live endpoint returns 200 for a token it has never seen, so the copy
    // must not claim the token was live until a moment ago — it claims only what
    // a 200 establishes: the token is not usable.
    assert.match(copy, /cannot be used again/);
    assert.doesNotMatch(copy, /revoked the refresh token it issued/);
    assert.equal(isRevocationUnresolved(report()), false);
  });

  it("does not claim a revocation that never happened", () => {
    const rejected = describeVclawSignOut(
      report({ revocation: "rejected", revocationStatus: 400 }),
    );
    assert.match(rejected, /refused to revoke/);
    assert.match(rejected, /HTTP 400/);
    assert.match(rejected, /usable until it expires/);
    assert.equal(
      isRevocationUnresolved(report({ revocation: "rejected" })),
      true,
      "a refusal must be flagged, or the toast reports a clean sign-out",
    );

    const unreachable = describeVclawSignOut(
      report({ revocation: "unreachable", revocationStatus: null }),
    );
    assert.match(unreachable, /could not be reached/);
    assert.match(unreachable, /refresh token was not revoked/);
    assert.equal(
      isRevocationUnresolved(report({ revocation: "unreachable" })),
      true,
    );

    const unreadable = describeVclawSignOut(
      report({ revocation: "cache_unreadable", revocationStatus: null }),
    );
    assert.match(unreadable, /no revocation was sent/);
    assert.equal(
      isRevocationUnresolved(report({ revocation: "cache_unreadable" })),
      true,
    );
  });

  it("treats 'nothing cached' as a clean outcome, not a failure", () => {
    const copy = describeVclawSignOut(
      report({ revocation: "no_cached_token", revocationStatus: null }),
    );
    assert.match(copy, /nothing to revoke/);
    assert.equal(
      isRevocationUnresolved(report({ revocation: "no_cached_token" })),
      false,
    );
  });

  it("does not claim a revocation for an unknown verdict from the boundary", () => {
    const copy = describeVclawSignOut(
      report({ revocation: "something_new", revocationStatus: 204 }),
    );
    assert.match(copy, /not recognised/);
    assert.match(copy, /treat the refresh token as unrevoked/);
  });
});
