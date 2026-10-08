import type {
  VclawBindReport,
  VclawBindState,
} from "@/shared/api/vclawPrincipalBind";

/**
 * WHAT A FAILED DEVICE BINDING SAYS TO THE PERSON (plan `docs/AUTH_BIND_PLAN.md`, jobs A2 and A4).
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────
 * Job A2: "Today a fresh install renders an empty app that is indistinguishable from an empty
 * estate — that is the defect this whole design exists to remove." The app entered the shell
 * whatever happened, so a binding that was never written looked exactly like an account with nothing
 * in it: no agents, no error, no next step.
 *
 * SO THERE IS NO SILENT STATE. Every state below is a heading a person can read, a sentence that
 * says what happened AND that nothing has loaded, and the label of the one control that retries.
 * `entersApp` is false for all of them but `bound`, and that is the gate the sign-in sequence reads.
 *
 * ── A4: DISTINCT, AND THE DISTINCTION IS THE WHOLE POINT ────────────────────
 * "not bound", "revoked" and "the IdP is unreachable" have DIFFERENT causes and DIFFERENT next
 * steps. One shared "something went wrong" would send a person to the wrong place — the estate's
 * wrong-layer failure mode, already in the pitfall log — so the states are separate TYPES
 * ([`VclawBindState`]), separate headings, and separate retry labels.
 *
 * ⚠ THE SENTENCES ARE FIXED STRINGS. The backend's `reason` is a code, rendered as an attribute for
 * support (`VclawBindNotice`), never interpolated into prose: a refusal message we did not write is
 * not a sentence we can vouch for, and this is copy a person reads on a failure screen.
 */
export type VclawBindCopy = {
  /** Short heading. Unique per state, so a screenshot or a selector can tell them apart. */
  title: string;
  /** What happened, that nothing has loaded, and what the person can do about it. */
  body: string;
  /** Label of the one control that retries the bind. Empty for `bound`, which has nothing to fix. */
  retryLabel: string;
  /** May the app be entered with this report? True for `bound` alone. */
  entersApp: boolean;
};

const COPY: Record<VclawBindState, VclawBindCopy> = {
  bound: {
    title: "Device bound",
    body: "This device is linked to your account.",
    retryLabel: "",
    entersApp: true,
  },
  "not-bound": {
    title: "This device is not bound to your account",
    body:
      "The account service refused to bind this device, so nothing has loaded — this is not an " +
      "empty account. Try again; if it keeps failing, ask your operator to check the device " +
      "binding for your account.",
    retryLabel: "Try again",
    entersApp: false,
  },
  revoked: {
    title: "This device was signed out of your account",
    body:
      "The binding for this device was revoked, so it can no longer reach your agents. Nothing " +
      "has loaded. Sign in again to add this device back to your account.",
    retryLabel: "Sign in again",
    entersApp: false,
  },
  "idp-unreachable": {
    // ⚠ THE TITLE USED TO SAY "We could not reach the sign-in service", AND THAT WAS WRONG.
    // Measured 2026-10-03, on a live attempt: the IdP was reachable throughout - discovery answered
    // 200, the authorization endpoint answered 302 straight to the portal with workflow=openid_connect,
    // and the token endpoint answered on POST. The bind reports this state from TWO causes, and BOTH
    // are credential-class, not transport-class (`vclaw_principal_bind.rs`):
    //   · `no_token`     - the silent session acquisition found NO SESSION. The app is not signed in.
    //   · `no_id_token`  - a session exists but the MEMORY-ONLY id_token holder is empty and the
    //                      refresh recovery could not refill it.
    // Calling that "we could not reach the sign-in service" sends the reader to their network, which
    // is the one place the fault is not.
    title: "You are not signed in on this device",
    body:
      "The app has no usable sign-in credential, so it did not try to bind this device and nothing " +
      "has loaded. This is not an empty account, and it is not a network fault. Sign in again to " +
      "continue. A new build can also land here on its own: the token cache is keyed by the " +
      "requested scopes, so adding a scope signs you out once.",
    retryLabel: "Sign in again",
    entersApp: false,
  },
  "service-unreachable": {
    title: "The account service is unreachable",
    body:
      "Sign-in succeeded, but the service that binds devices did not answer, so nothing has " +
      "loaded — your agents have not been fetched, and this is not an empty account. Try again " +
      "in a moment.",
    retryLabel: "Try again",
    entersApp: false,
  },
  unreadable: {
    title: "We could not confirm this device's binding",
    body:
      "The app did not get a usable answer when it bound this device, so it stopped here rather " +
      "than show you an account it cannot vouch for. Nothing has loaded. Try again.",
    retryLabel: "Try again",
    entersApp: false,
  },
};

/** The copy for a state. Total over the type, so a new state cannot reach the screen unwritten. */
export function describeVclawBindState(state: VclawBindState): VclawBindCopy {
  return COPY[state];
}

/**
 * The one-line form of a failure, for a log or a caller that needs a sentence rather than a surface.
 * Composed from the SAME copy the screen renders, so the two can never disagree.
 */
export function describeVclawBindFailure(report: VclawBindReport): string {
  const copy = describeVclawBindState(report.state);
  return `${copy.title}. ${copy.body}`;
}

/** Whether the app may be entered with this report. The gate, in one place. */
export function vclawBindEntersApp(report: VclawBindReport): boolean {
  return describeVclawBindState(report.state).entersApp;
}

/**
 * True when the bind succeeded but the estate's vgate segment stamp did NOT
 * land (`npub_stamped: false`). This is NOT a hard failure — the forward never
 * fails the bind — but it must not be silent: the device is bound yet cannot
 * administer channels until it re-binds.
 */
export function isUnstampedBind(report: VclawBindReport): boolean {
  return report.state === "bound" && report.npubStamped === false;
}

/** The one-line warning shown when a bound device's segment stamp did not land. */
export function describeUnstampedBindWarning(): string {
  return (
    "This device is bound, but cannot administer channels until it re-binds — " +
    "the segment stamp did not land. Sign out and sign in again to re-bind."
  );
}
