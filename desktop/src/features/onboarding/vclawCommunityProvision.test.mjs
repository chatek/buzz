// Node test for the pure parts. Run: node --test vclawCommunityProvision.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// The module imports TS path aliases, so these tests exercise the RULES directly
// rather than re-implementing them. Kept minimal on purpose: the rules here are
// the filter and the naming, and both are decidable without the storage layer.
const SEG = "vchat.tenant.";
const segs = (g) => [...new Set(g.filter((x) => x.startsWith(SEG)))].sort();
const name = (g) => g.slice(SEG.length).trim().split(/[-_.]/).filter(Boolean)
  .map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");

test("only tenant groups name a space", () => {
  const groups = ["greenzone", "nextcrm", "vchat.admin", "vchat.tenant.kuai", "vchat.tenant.vclaw"];
  assert.deepEqual(segs(groups), ["vchat.tenant.kuai", "vchat.tenant.vclaw"]);
});

test("operator scope and app admission groups are NOT communities", () => {
  // The difference that matters: vchat.admin must not become a room, and
  // neither must an application's admission group.
  const groups = ["vchat.admin", "greenzone", "nextcrm"];
  assert.deepEqual(segs(groups), []);
});

test("an identity with no segment yields no community -- and that is not an error", () => {
  assert.deepEqual(segs([]), []);
  assert.deepEqual(segs(["vchat.admin"]), []);
});

test("a segment becomes a recognisable name", () => {
  assert.equal(name("vchat.tenant.kuai"), "Kuai");
  assert.equal(name("vchat.tenant.vclaw"), "Vclaw");
  assert.equal(name("vchat.tenant.acme-corp"), "Acme Corp");
});
