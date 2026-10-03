// Node test for the tenant-group NAMING rules.
//
// Run it through the repo's own test script (test-loader.mjs resolves the `@/` aliases and
// TypeScript), e.g.
//   node --import ./test-loader.mjs --experimental-strip-types --test <this file>
//
// ⚠️ WHY THIS FILE NOW IMPORTS THE MODULE INSTEAD OF RE-IMPLEMENTING IT.
// Its first version mirrored the rules in the test (`const SEG = "vchat.tenant."`, its own `segs()`
// and `name()`) and asserted on the mirror. That is a check that cannot fail when the shipped code
// changes: when the naming ruling moved to canonical `vclaw.tenant.` with `vchat.tenant.` as a legacy
// alias (operator ruling 2026-10-03, `vchat` sunset 2026-11-02), the mirror kept passing while
// `segmentDisplayName()` sliced a prefix that canonical groups do not carry. The rules are imported
// from the module under test now.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEGMENT_GROUP_CANONICAL_PREFIX,
  SEGMENT_GROUP_LEGACY_PREFIX,
  SEGMENT_GROUP_PREFIXES,
  SEGMENT_LEGACY_SUNSET,
  segmentDisplayName,
  segmentGroupEntry,
  segmentGroups,
} from "./vclawCommunityProvision.ts";

test("the prefix is a LIST: canonical first, legacy second and marked temporary", () => {
  assert.equal(SEGMENT_GROUP_PREFIXES[0], "vclaw.tenant.");
  assert.equal(SEGMENT_GROUP_PREFIXES[1], "vchat.tenant.");
  assert.equal(SEGMENT_GROUP_CANONICAL_PREFIX, "vclaw.tenant.");
  assert.equal(SEGMENT_GROUP_LEGACY_PREFIX, "vchat.tenant.");
  // The legacy alias is accepted ONLY until the sunset, and the date is carried, not paraphrased.
  assert.equal(SEGMENT_LEGACY_SUNSET, "2026-11-02");
});

test("only tenant groups name a space", () => {
  const groups = [
    "greenzone",
    "nextcrm",
    "vchat.admin",
    "vclaw.tenant.kuai",
    "vchat.tenant.vclaw",
  ];
  assert.deepEqual(segmentGroups(groups), [
    "vchat.tenant.vclaw",
    "vclaw.tenant.kuai",
  ]);
});

test("operator scope and app admission groups are NOT segments", () => {
  assert.deepEqual(segmentGroups(["vchat.admin", "greenzone", "nextcrm"]), []);
});

test("a LEGACY-only identity still names a space — never an empty list", () => {
  // The reason the constant became a list: with the legacy prefix alone, this identity rendered as
  // an identity with no segment at all.
  assert.deepEqual(segmentGroups(["vchat.tenant.kuai"]), ["vchat.tenant.kuai"]);
  const entry = segmentGroupEntry("vchat.tenant.kuai");
  assert.equal(
    entry?.legacy,
    true,
    "the legacy alias is MARKED, not shown as current",
  );
  assert.equal(entry?.name, "kuai");
  assert.equal(entry?.displayName, "Kuai");
  assert.equal(entry?.canonicalGroup, "vclaw.tenant.kuai");
});

test("the canonical group is not legacy, and its display name is derived from its own prefix", () => {
  const entry = segmentGroupEntry("vclaw.tenant.kuai");
  assert.equal(entry?.legacy, false);
  assert.equal(entry?.prefix, "vclaw.tenant.");
  assert.equal(segmentDisplayName("vclaw.tenant.kuai"), "Kuai");
});

test("a group with no known prefix is returned unchanged, not sliced", () => {
  assert.equal(segmentGroupEntry("greenzone"), null);
  assert.equal(segmentDisplayName("greenzone"), "greenzone");
  assert.equal(segmentDisplayName("vchat.admin"), "vchat.admin");
});

test("a segment becomes a recognisable name under either prefix", () => {
  assert.equal(segmentDisplayName("vclaw.tenant.acme-corp"), "Acme Corp");
  assert.equal(segmentDisplayName("vchat.tenant.acme-corp"), "Acme Corp");
  assert.equal(segmentDisplayName("vclaw.tenant.vclaw"), "Vclaw");
});

test("a prefix with no name names nothing", () => {
  assert.equal(segmentGroupEntry("vclaw.tenant."), null);
  assert.deepEqual(segmentGroups(["vclaw.tenant."]), []);
});
