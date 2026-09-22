/**
 * THE HONESTY RULE OF THIS LANE, as one pure function: what may this console say
 * about a decision it renders?
 *
 * READ FROM THE CONTRACT, NOT INVENTED. `.prime/handoff/idp-build/j19/PHASE2_DESIGN.md`
 * §6.1-§6.3:
 *
 *  - the gateway's ONE authorization function boots in **shadow** mode
 *    (`READ buzz-gateway/internal/identity/identity.go:100-101, :127`). In shadow
 *    it records would-be denials in a bounded ring and returns the LEGACY
 *    outcome. So an "allow" it produced is not a decision it enforced;
 *  - the ONE live HTTP surface for the mode is `GET /api/authz/shadow`, and it is
 *    NIP-98-wrapped, which a browser cannot sign (`READ internal/api/lane_auth.go:66-77`).
 *    So the console renders **unknown**, never "shadow" and never "enforce";
 *  - NIP-FI's `deny-until-TTL` set (`READ internal/nipfi/denyset.go:9-31`) is now
 *    ADMINISTERED through a route (`READ buzz-gateway/internal/nipfi/denyadmin.go`:
 *    `DenyMountPath` + `DenyBarePath`, registered at `cmd/gateway/main.go`), and that
 *    route is NIP-98-protected. It is still not READABLE from a browser: a browser has
 *    no key pair, so it cannot produce the header the wrapper requires. So
 *    `deny_until_ttl.available` stays `false` and its `entries` number still means
 *    nothing. A `0` there would read as "nothing is revoked", which is a claim nobody
 *    made. The reason changed; the rendering did not.
 *
 * THE INVARIANT THIS FILE ENFORCES IN ITS OWN CODE:
 *
 *     allowsAreEnforcement === (state.available === true && state.mode === "enforce")
 *
 * It is DERIVED here and never copied from the payload's `allows_are_enforcement`
 * field. The payload's copy is derived too (§6.3), but a derived summary that
 * arrives over the wire can disagree with the fields it summarizes — and this is
 * the one field in the whole feature that decides whether the word "allow" means
 * anything, so the console derives its own and REPORTS the disagreement instead
 * of rendering either version silently. Any headline other than the enforce one
 * says, in words, that an "allow" is not an enforcement result.
 *
 * PURE: no fetch, no React, no clock.
 */

import type { DenyUntilTTLState, EnforcementState } from "./phase2-types";

/** The two modes `mode` may name. Anything else is UNKNOWN, not "not shadow" (§6.3). */
export const ENFORCE_MODE = "enforce";
export const SHADOW_MODE = "shadow";

export type EnforcementRendering = {
  /** True only when the reader SAID `shadow`. Never "not enforcing". */
  shadowMode: boolean;
  /** The invariant above, derived. */
  allowsAreEnforcement: boolean;
  headline: string;
  detail: string;
  /** The mode as reported, `""` when unknown. Kept so a renderer can echo it verbatim. */
  mode: string;
  /** The payload contradicted the derived invariant. Rendered, not swallowed. */
  payloadDisagrees: boolean;
};

/**
 * `"shadow" | "enforce" | ""`. Recognised EXACTLY, with no trimming and no case
 * folding: the invariant this file enforces is
 * `available === true && mode === "enforce"`, and a mode that is not exactly one
 * of the two is UNKNOWN. Being lenient here would be the one direction that is
 * unsafe — a padded or cased "enforce" would be promoted to an enforcement
 * result, which is exactly the claim this lane exists to refuse.
 */
function normaliseMode(mode: unknown): string {
  return mode === SHADOW_MODE || mode === ENFORCE_MODE ? mode : "";
}

/** The raw, unnormalised mode text, for the sentence that names what arrived. */
function rawModeText(state: EnforcementState | null | undefined): string {
  const raw = typeof state?.mode === "string" ? state.mode.trim() : "";
  return raw === "" ? "empty" : raw;
}

/**
 * THE INVARIANT, in one place. Everything that asks "does an allow mean
 * something" asks here, so there is exactly one answer in this feature.
 */
export function allowsAreEnforcement(
  state: EnforcementState | null | undefined,
): boolean {
  return (
    state?.available === true && normaliseMode(state.mode) === ENFORCE_MODE
  );
}

/**
 * Why the mode is unknown. Returns `""` when it is known — there is then nothing
 * unknown to explain, and an empty string is the honest answer rather than a
 * sentence invented to fill the space.
 */
export function enforcementUnknownReason(
  state: EnforcementState | null | undefined,
): string {
  if (state === null || state === undefined) {
    return "this payload carried no enforcement object at all, so the mode is unknown rather than shadow: an absent answer is not an answer of 'nothing is enforced'.";
  }
  if (state.available !== true) {
    const note = typeof state.note === "string" ? state.note.trim() : "";
    const base =
      "the enforcement mode is not readable from a browser: the only surface that exposes it is the shadow read, which is behind the NIP-98 lane guard and cannot be signed by a browser. The console therefore renders unknown, not shadow and not enforce.";
    return note === "" ? base : `${base} The reader said: ${note}`;
  }
  const observed = normaliseMode(state.mode);
  if (observed === "") {
    return `the reader answered with mode "${rawModeText(state)}", which is neither shadow nor enforce. An unrecognised mode is not "not shadow", so nothing here is an enforcement result.`;
  }
  return "";
}

/**
 * The rendering model for the banner. Four required fields plus the mode and the
 * disagreement flag; `headline` carries the invariant in words, so a reader who
 * sees only the headline is not misled.
 */
export function describeEnforcement(
  state: EnforcementState | null | undefined,
): EnforcementRendering {
  const available = state?.available === true;
  const observed = normaliseMode(state?.mode);
  const derived = allowsAreEnforcement(state);
  const shadowMode = available && observed === SHADOW_MODE;
  const source =
    typeof state?.source === "string" && state.source.trim() !== ""
      ? state.source
      : "an unnamed source";
  const wouldDeny =
    typeof state?.would_deny_entries === "number"
      ? state.would_deny_entries
      : null;
  // The payload's own summary, kept only to be compared with the derived value.
  // Both directions are reported: a payload that claims `true` under shadow and
  // one that claims `false` under enforce are the same defect from two sides.
  const payloadDisagrees =
    typeof state?.allows_are_enforcement === "boolean" &&
    state.allows_are_enforcement !== derived;

  if (!available) {
    return {
      shadowMode,
      allowsAreEnforcement: false,
      headline:
        "ENFORCEMENT UNKNOWN — the authorization mode could not be read. An 'allow' below is not an enforcement result.",
      detail: enforcementUnknownReason(state),
      mode: "",
      payloadDisagrees,
    };
  }

  if (observed === ENFORCE_MODE) {
    const count =
      wouldDeny === null
        ? "The would-deny counter was not reported."
        : `The reader's would-deny counter holds ${wouldDeny} entries.`;
    return {
      shadowMode,
      allowsAreEnforcement: true,
      headline:
        "ENFORCE MODE — the authorization function is enforcing. An 'allow' below is an enforcement result.",
      detail: `The mode was read from ${source}. ${count} Under enforce, an unbound writer is refused and a revoked membership is refused with the gateway's own "restricted:" wording.`,
      mode: observed,
      payloadDisagrees,
    };
  }

  if (observed === SHADOW_MODE) {
    const count =
      wouldDeny === null
        ? "The reader did not report a would-deny count."
        : `The would-deny ring holds ${wouldDeny} decision(s) that ENFORCE would have refused.`;
    return {
      shadowMode,
      allowsAreEnforcement: false,
      // The design's own sentence, verbatim (§6.3).
      headline:
        "SHADOW MODE — the authorization function logs decisions and enforces nothing. An 'allow' below is the legacy outcome, not an enforcement result.",
      detail: `The mode was read from ${source}. ${count} Nothing below was refused because of this banner.`,
      mode: observed,
      payloadDisagrees,
    };
  }

  return {
    shadowMode,
    allowsAreEnforcement: false,
    headline: `ENFORCEMENT UNKNOWN — the reader answered with mode "${rawModeText(state)}", which this console does not recognise. An 'allow' below is not an enforcement result.`,
    detail: enforcementUnknownReason(state),
    mode: "",
    payloadDisagrees,
  };
}

export type DenyUntilTTLRendering = {
  available: boolean;
  /** A number ONLY when available; `null` means "not reported", never zero. */
  entries: number | null;
  sentence: string;
};

/**
 * The deny-until-TTL set (§6.2). The number is `null` when the set is not
 * readable, and the sentence says so, because `entries: 0` from the struct means
 * nothing while `available` is false and would render as "nothing is revoked".
 */
export function describeDenyUntilTTL(
  state: EnforcementState | null | undefined,
): DenyUntilTTLRendering {
  const deny: DenyUntilTTLState | undefined = state?.deny_until_ttl;
  if (deny === undefined || deny.available !== true) {
    const note = typeof deny?.note === "string" ? deny.note.trim() : "";
    // J20: the surface EXISTS and is NIP-98-protected. The console still reports no
    // count - the reason changed, the rendering did not (design §6.2 as amended).
    const base =
      "the deny-until-TTL set is administered through a NIP-98-protected route (`/api/nip-fi/deny`), and a browser cannot sign a NIP-98 header, so this console cannot say how many keys are revoked right now. The count below is not reported, and it is not zero.";
    return {
      available: false,
      entries: null,
      sentence: note === "" ? base : `${base} The backend said: ${note}`,
    };
  }
  const entries = typeof deny.entries === "number" ? deny.entries : null;
  const exposedBy =
    typeof deny.exposed_by === "string" && deny.exposed_by.trim() !== ""
      ? deny.exposed_by.trim()
      : "an unnamed source";
  return {
    available: true,
    entries,
    sentence: `Read from ${exposedBy}. A zero here means the set is empty NOW; it is not a statement about revocations that have already expired.`,
  };
}
