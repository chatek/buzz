/**
 * RULING C(i) client half (CHANNELS_SERVICE_ACL.md §5) — the NIP-11 `channels`
 * capability parser and the derived affordance set. Present / absent /
 * malformed / partial, and the byte-identical-fallback contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNELS_ALPHA_AFFORDANCES,
  deriveChannelsAlphaAffordances,
  parseChannelsCapabilities,
} from "./channelsAlphaAffordances.ts";

/** The set the gateway actually advertises today (nip01/server.go defaults). */
const GATEWAY_SET = {
  dm: true,
  sections: false,
  stars: false,
  mutes: false,
  sort: false,
  templates: false,
  canvases: false,
  agent_activity: "deferred",
};

test("present: the gateway's full set parses to every known key", () => {
  const parsed = parseChannelsCapabilities(GATEWAY_SET);
  assert.deepEqual(parsed, {
    directMessages: true,
    sections: false,
    stars: false,
    mutes: false,
    sort: false,
    templates: false,
    canvases: false,
  });
});

test("present: agent_activity is accepted on the wire and ignored by the affordances", () => {
  const parsed = parseChannelsCapabilities(GATEWAY_SET);
  // No affordance key exists for it (tri-state, no consumer yet): it must be
  // neither a crash nor an invented verdict.
  assert.equal("agentActivity" in parsed, false);
  assert.equal("agent_activity" in parsed, false);
});

test("absent: null (document has no channels field → the whole table falls back)", () => {
  assert.equal(parseChannelsCapabilities(undefined), null);
  assert.equal(parseChannelsCapabilities(null), null);
  assert.equal(parseChannelsCapabilities({ name: "buzz-gateway" }), null);
  assert.equal(parseChannelsCapabilities({ channels: undefined }), null);
});

test("malformed: not-an-object shapes are null", () => {
  assert.equal(parseChannelsCapabilities("dm"), null);
  assert.equal(parseChannelsCapabilities(true), null);
  assert.equal(parseChannelsCapabilities(["dm"]), null);
  assert.equal(parseChannelsCapabilities(7), null);
});

test("malformed: a non-boolean VALUE is not a verdict — the key falls back", () => {
  // No known key stated a boolean, so the parse is null (whole-table
  // fallback); dm keeps its compile-time verdict because "yes" is a string,
  // not a verdict. Never invented, never coerced.
  const parsed = parseChannelsCapabilities({ dm: "yes", stars: 1 });
  assert.equal(parsed, null);
  assert.equal(deriveChannelsAlphaAffordances(parsed).directMessages, true);
});

test("malformed VALUE next to a valid one: the valid key still derives", () => {
  const parsed = parseChannelsCapabilities({ dm: "yes", sort: true });
  assert.deepEqual(parsed, { sort: true });
  const derived = deriveChannelsAlphaAffordances(parsed);
  assert.equal(derived.directMessages, true, "malformed dm falls back");
  assert.equal(derived.sort, true, "valid sort wins");
});

test("partial: only the stated keys derive, the rest keep the compile-time verdict", () => {
  const parsed = parseChannelsCapabilities({ dm: false, sort: true });
  assert.deepEqual(parsed, { directMessages: false, sort: true });
  const derived = deriveChannelsAlphaAffordances(parsed);
  assert.equal(derived.directMessages, false, "stated key wins");
  assert.equal(derived.sort, true, "stated key wins");
  assert.equal(derived.sections, CHANNELS_ALPHA_AFFORDANCES.sections);
  assert.equal(derived.templates, CHANNELS_ALPHA_AFFORDANCES.templates);
  assert.equal(derived.canvases, CHANNELS_ALPHA_AFFORDANCES.canvases);
});

test("unknown keys are ignored (a future relay capability cannot flip a client affordance)", () => {
  const parsed = parseChannelsCapabilities({
    dm: true,
    ai_stories: false,
    "future-thing": true,
  });
  assert.deepEqual(parsed, { directMessages: true });
});

test("the acceptance leg: dm=false on the relay flips exactly the DM affordance", () => {
  const derived = deriveChannelsAlphaAffordances(
    parseChannelsCapabilities({ ...GATEWAY_SET, dm: false }),
  );
  assert.equal(derived.directMessages, false);
  // every other verdict is the advertised one
  assert.equal(derived.sections, false);
  assert.equal(derived.templates, false);
});

test("byte-identical fallback: absent field returns THE compile-time object", () => {
  const derived = deriveChannelsAlphaAffordances(
    parseChannelsCapabilities({ supported_nips: [1, 11, 43] }),
  );
  assert.equal(derived, CHANNELS_ALPHA_AFFORDANCES);
  assert.equal(
    parseChannelsCapabilities({ supported_nips: [1, 11, 43] }),
    null,
  );
});

test("byte-identical fallback: a same-verdict derive does not claim to be the fallback object", () => {
  // The gateway's defaults EQUAL the compile-time table; the derived set is a
  // NEW frozen object with the same values — equal verdicts, different
  // identity. Render sites must never depend on the identity, so pin that.
  const derived = deriveChannelsAlphaAffordances(
    parseChannelsCapabilities(GATEWAY_SET),
  );
  assert.notEqual(derived, CHANNELS_ALPHA_AFFORDANCES);
  for (const key of Object.keys(CHANNELS_ALPHA_AFFORDANCES)) {
    assert.equal(
      derived[key],
      CHANNELS_ALPHA_AFFORDANCES[key],
      `key ${key} must keep the compile-time verdict`,
    );
  }
});
