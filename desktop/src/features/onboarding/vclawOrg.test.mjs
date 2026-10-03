// Node test for the ORG FIELD's rules — the pure half of it, with no JSDOM.
//
// Run through the repo's own test script, e.g.
//   node --import ./test-loader.mjs --experimental-strip-types --test <this file>
//
// WHAT IS HERE AND WHAT IS NOT: this file covers the LOCAL check (shape only: required, trimmed,
// case-folded, length, charset) and the ESTATE's decision over a claim. It cannot cover the two
// surfaces that carry them (the field that gates the button, the screen that shows the answer) —
// those are asserted against the mounted DOM in `ui/vclawSignInOnly.test.mjs` and in
// `tests/e2e/vclaw-signin-only.spec.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VCLAW_DEFAULT_ORG,
  VCLAW_ORG_MAX_LENGTH,
  validateOrgEntry,
  verifyOrgAgainstClaim,
} from "./vclawOrg.ts";

/** The claim a real login returns: both forms of `kuai`, and the canonical default. */
const CLAIM = [
  "vclaw.tenant.vclaw",
  "vclaw.tenant.kuai",
  "vchat.tenant.kuai",
  "vchat.admin",
];

test("the default is vclaw, and it is a value the field SHOWS rather than an empty-field meaning", () => {
  assert.equal(VCLAW_DEFAULT_ORG, "vclaw");
  assert.equal(validateOrgEntry(VCLAW_DEFAULT_ORG).ok, true);
});

test("the local check is shape only: required, trimmed, case-folded, length, charset", () => {
  // Trimming and case-folding are ACCEPTED and reported, not silently applied.
  const spaced = validateOrgEntry("  Kuai  ");
  assert.equal(spaced.ok, true);
  assert.equal(spaced.entry.trimmed, "Kuai");
  assert.equal(spaced.entry.folded, "kuai");
  assert.match(spaced.message, /case-folded/);

  // A pasted group name is read through its prefix, canonical or legacy.
  assert.equal(validateOrgEntry("vclaw.tenant.kuai").entry.folded, "kuai");
  const legacyForm = validateOrgEntry("vchat.tenant.kuai");
  assert.equal(legacyForm.ok, true);
  assert.equal(legacyForm.entry.folded, "kuai");
  assert.equal(legacyForm.entry.legacyPrefix, true);
  assert.match(legacyForm.message, /LEGACY prefix/);
  assert.match(legacyForm.message, /2026-11-02/);
});

test("an empty or malformed entry fails, and says what would be right", () => {
  for (const [input, problem] of [
    ["", "empty"],
    ["   ", "empty"],
    ["vclaw.tenant.", "empty"],
    ["x", "too-short"],
    [`a${"b".repeat(VCLAW_ORG_MAX_LENGTH)}`, "too-long"],
    ["!!", "shape"],
    ["ku ai", "shape"],
    ["-kuai", "shape"],
    ["kuai-", "shape"],
  ]) {
    const result = validateOrgEntry(input);
    assert.equal(result.ok, false, `"${input}" must not pass`);
    assert.equal(result.problem, problem, `"${input}"`);
    // EVERY failure names what is wrong AND what is accepted: a silent refusal is a defect here.
    assert.ok(result.message.length > 20, `"${input}" needs a real message`);
  }
});

test("the ESTATE decides: a granted org resolves to the claim's own string", () => {
  const verdict = verifyOrgAgainstClaim("Kuai", CLAIM);
  assert.equal(verdict.status, "granted");
  assert.equal(verdict.grant?.group, "vclaw.tenant.kuai");
  assert.equal(verdict.grant?.legacy, false);
  // BOTH are shown when the answer is not textually the entry: nothing is substituted in silence.
  assert.equal(verdict.differsFromEntry, true);
  assert.match(verdict.message, /You entered "Kuai"/);
  assert.match(verdict.message, /the estate's answer is "vclaw\.tenant\.kuai"/);
});

test("the canonical prefix wins when the claim carries both forms", () => {
  const verdict = verifyOrgAgainstClaim("kuai", CLAIM);
  assert.equal(verdict.status, "granted");
  assert.equal(verdict.grant?.group, "vclaw.tenant.kuai");
  assert.ok(!/LEGACY/.test(verdict.message));
});

test("a legacy-only claim gets in, MARKED as legacy rather than shown as current", () => {
  const verdict = verifyOrgAgainstClaim("kuai", [
    "vchat.tenant.kuai",
    "vchat.admin",
  ]);
  assert.equal(verdict.status, "legacy");
  assert.equal(verdict.grant?.group, "vchat.tenant.kuai");
  assert.equal(verdict.grant?.legacy, true);
  assert.match(verdict.message, /LEGACY alias/);
  assert.match(verdict.message, /Canonical is "vclaw\.tenant\.kuai"/);
  assert.match(verdict.message, /2026-11-02/);
});

test("an org the estate does not grant STOPS, and the refusal lists no other org", () => {
  const verdict = verifyOrgAgainstClaim("acme-corp", CLAIM);
  assert.equal(verdict.status, "not-granted");
  assert.equal(verdict.grant, null);
  assert.match(verdict.message, /did not grant the org "acme-corp"/);
  assert.match(verdict.message, /no community was entered/);
  // NO ENUMERATION: not one of the groups this claim does carry is named in the refusal.
  for (const group of CLAIM) {
    assert.ok(
      !verdict.message.includes(group),
      `the refusal must not name ${group}: a catalogue of the estate's tenants is exactly what the
       field must not render`,
    );
  }
  assert.ok(!verdict.message.includes("kuai"));
});

test("no default -> vclaw ALIAS exists: the estate's own string is the only answer", () => {
  // The room plane renames the segment VALUE `default` to `vclaw`. A UI that translated between the
  // two would be asserting an alias the estate never confirmed, so `vclaw` against a claim that
  // answers `default` is a MISS, not a substitution.
  const verdict = verifyOrgAgainstClaim("vclaw", ["vclaw.tenant.default"]);
  assert.equal(verdict.status, "not-granted");
  assert.equal(verdict.message.includes("vclaw.tenant.default"), false);
  // And the reverse: the claim that carries `vclaw` answers the entry `vclaw` exactly.
  assert.equal(
    verifyOrgAgainstClaim("vclaw", CLAIM).grant?.group,
    "vclaw.tenant.vclaw",
  );
});
