import { invokeTauri } from "./tauri";

// ── The account -> device binding, from the APP's side ─────────────────────
//
// Design of record: `docs/AUTH_BIND_PLAN.md` (jobs A1-A4, tests T3/T6). A principal may have MANY
// active npubs; the relay still authorises by npub, and this is the app half of the self-service way
// to CREATE the binding the relay already reads.
//
// ── WHERE THE CREDENTIALS LIVE: THIS FILE NEVER SEES ONE ────────────────────
// The bind needs TWO credentials — the caller's OIDC access token and a NIP-98 proof signed by this
// device's key. Neither crosses this boundary, and that is deliberate:
//
//   · The access token is held by the Rust session engine. `vclaw_oidc.rs` states the posture
//     ("nothing in this module sends it anywhere but the IdP's own userinfo endpoint"), and handing
//     it to the webview would widen its exposure to anything that can run script in a renderer that
//     renders remote message content.
//   · NIP-98 signing with the device key is already native (`relay.rs::build_nip98_auth_header`,
//     which the relay HTTP calls use), and the key is in the OS keyring, not in the webview.
//
// So the app calls ONE semantic command with NO ARGUMENTS. `builderlab.rs` is the same shape for the
// same reason: a native command owns the credential and returns an ANSWER, not a secret.
//
// ── WHAT THE NATIVE COMMAND MUST DO (its side of the contract) ──────────────
// 1. Acquire the cached OIDC access token (the same `PkceOAuthTokenSource` `vclaw_oidc_login` uses;
//    silent — a fresh sign-in has just cached one).
// 2. Sign a NIP-98 event (kind 27235) over the bind request: tags `u` (the exact absolute URL),
//    `method` `POST`, `payload` (sha256 of the body), `nonce` — the estate's existing NIP-98 shape,
//    reused rather than reinvented (`relay.rs`).
// 3. POST it to the estate's `POST /api/principal/device/bind` (job J1) with the token AND the proof.
//    The path is under `/api/` by the lead's ruling: that is the ingress the estate's edge ALREADY
//    serves, while the plan's original `/v1/...` path answered `405 text/html` from nginx's static
//    handler on the live estate — a new endpoint must not need a host change to be reachable. The
//    header is `X-Vclaw-Oidc-Token: Bearer <id_token>` beside `Authorization: Nostr <base64 event>`
//    (J1's `DeviceBindTokenHeader`); this app builds neither, so only that constant moves if they
//    rename it.
// 4. Return a [`VclawBindReport`] — an OUTCOME and a reason CODE, never a token, never a body dump.
//
// Until J1 and that command land, the invoke REJECTS (Tauri's "command not found"), which this file
// reports as [`VclawBindState`] `"unreadable"`: the app says it could not confirm the binding and
// stays on the sign-in screen. That is the intended behaviour, not a fallback — A2 exists because a
// silently empty app is indistinguishable from an empty estate.
//
// ── THE COMMAND NAME IS A CONTRACT ─────────────────────────────────────────
export const VCLAW_BIND_COMMAND = "vclaw_bind_principal_device";

/**
 * The user-visible states of a bind attempt. ONE per outcome class, so A4's "distinct surfaces" is a
 * property of this type rather than a habit of whichever component renders it.
 *
 * - `bound`             — the row exists and names THIS device. The only state that enters the app.
 * - `not-bound`         — the pair was refused (bad/expired token, bad/replayed proof, a body
 *                         claiming another principal, or a binding that is simply missing).
 * - `revoked`           — this device's binding was revoked (job J3): the credential is refused while
 *                         the principal's other devices keep working.
 * - `idp-unreachable`   — no valid token could be obtained, so nothing was even attempted.
 * - `service-unreachable` — the bind endpoint did not answer (transport failure or 5xx). The estate
 *                         may be perfectly non-empty; the app simply could not confirm anything.
 * - `unreadable`        — the app got no usable answer: the command is absent (J1 has not landed), the
 *                         report was malformed, or a SUCCESS claim was not self-consistent.
 *
 * ⚠ `unreadable` IS NOT A POLITE NAME FOR SUCCESS, and this type has no `unknown` member that falls
 * back to one. A missing required field reading as `undefined` is the failure mode this estate has
 * already paid for once (`vclawOidc.ts`, the `subject`/`sub` mismatch: a required field read as
 * `undefined` produced a silently wrong string instead of an error), so every field below is
 * validated individually and anything unrecognised lands here.
 */
export type VclawBindState =
  | "bound"
  | "not-bound"
  | "revoked"
  | "idp-unreachable"
  | "service-unreachable"
  | "unreadable";

export type VclawBindReport = {
  state: VclawBindState;
  /** The native layer's own outcome word, VERBATIM and validated, or `null`. */
  outcome: string | null;
  /**
   * The backend's refusal reason, as a short code (`proof_replayed`), or `null`.
   *
   * A CODE and not prose: it is shown as an attribute for support, never as the sentence a person
   * reads, so a backend that ever returned a token-shaped string cannot render it here. `isCode`
   * below is the only thing that admits a value.
   */
  reason: string | null;
  /** HTTP status of the bind POST, when one was sent. */
  status: number | null;
  /** True when this call wrote nothing because the row (and its device entry) already existed. */
  idempotent: boolean;
  /** The npub the row was written for (64 hex), when the native layer was told one. */
  npub: string | null;
  /**
   * Whether the estate's vgate segment stamp landed, when it said so as a
   * boolean. `null` means "not stated". `false` is NOT a hard failure — the
   * forward never fails the bind — but it is surfaced as the named warning
   * "bound, but cannot administer channels until it re-binds".
   */
  npubStamped: boolean | null;
};

/** The native layer's outcome vocabulary. Anything else is `unreadable`, never a guess. */
const BOUND_OUTCOMES = new Set(["bound", "already_bound"]);
const OUTCOME_STATES: Record<string, VclawBindState> = {
  bound: "bound",
  already_bound: "bound",
  refused: "not-bound",
  revoked: "revoked",
  idp_unreachable: "idp-unreachable",
  service_unreachable: "service-unreachable",
  /**
   * The native layer's OWN "I got an answer, but not an answer about this device" — the case that
   * exists today because J1 is not deployed: a 404/405 (the path is not there) arrives with reason
   * `endpoint_absent`. It is admitted as a NAMED outcome, with its reason code, rather than left to
   * fall through as unrecognised: the state is the same (nothing is entered, and it is said out
   * loud), but the reason it reaches support is the native layer's own rather than `unknown_outcome`.
   */
  unreadable: "unreadable",
};

/** A reason code: short, lowercase, no whitespace — so it cannot carry prose or a credential. */
function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value);
}

function isNpubHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function readStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** An outcome the app could not read at all: stated as such, with nothing invented. */
function unreadable(reason: string | null, status: number | null = null) {
  return {
    state: "unreadable" as const,
    outcome: null,
    reason,
    status,
    idempotent: false,
    npub: null,
    npubStamped: null,
  };
}

/**
 * Read a raw bind report — defensively, field by field.
 *
 * `devicePubkey` is the device key this app signs with. When the native layer names the npub it
 * wrote the row for, it must be THAT key: a report claiming a binding for another npub would make
 * "this device is bound" a claim the app cannot support, and it is reported as `unreadable`.
 */
export function classifyVclawBindReport(
  raw: unknown,
  devicePubkey: string | null,
): VclawBindReport {
  if (!raw || typeof raw !== "object") return unreadable("malformed_report");
  const report = raw as Record<string, unknown>;
  const outcome = typeof report.outcome === "string" ? report.outcome : null;
  const state = outcome === null ? undefined : OUTCOME_STATES[outcome];
  if (state === undefined) return unreadable("unknown_outcome");

  const reason = isReasonCode(report.reason) ? report.reason : null;
  const status = readStatus(report.status);
  // ABSENT and UNREADABLE are different facts, and only the first one is acceptable: a report that
  // simply does not name an npub is a report with nothing to cross-check, while one that names
  // something this layer cannot read is a report it cannot stand behind.
  const npubField = report.npub;
  // ABSENT, and the adopted envelope's `""`, are the same fact: J1 names no key on a refusal
  // (`buzz-gateway/internal/api/device_bind_http.go`: "or "" when this refusal did not establish
  // one"). An empty string is therefore read as "nothing to cross-check", NOT as an unreadable npub
  // — otherwise every successful-but-anonymous field would be reported as a report we cannot act on.
  const npubAbsent =
    npubField === undefined || npubField === null || npubField === "";
  const npub = isNpubHex(npubField) ? npubField : null;
  // A stamp verdict is only a boolean. Anything else is "not stated", never a
  // guess — reading a string as "stamped" would re-silence the exact failure
  // this field exists to surface (key-lifecycle audit #4).
  const npubStamped =
    typeof report.npubStamped === "boolean" ? report.npubStamped : null;

  if (BOUND_OUTCOMES.has(outcome ?? "")) {
    // A SUCCESS CLAIM MUST BE SELF-CONSISTENT. A 4xx/5xx status beside "bound" is a contradiction; a
    // named-but-unreadable npub means the claim cannot be checked; and a row written for a DIFFERENT
    // npub is not this device's binding at all.
    if (status !== null && (status < 200 || status >= 300)) {
      return unreadable(reason, status);
    }
    if (!npubAbsent && npub === null) {
      return unreadable("malformed_npub", status);
    }
    if (
      npub !== null &&
      devicePubkey !== null &&
      npub !== devicePubkey.toLowerCase()
    ) {
      return unreadable("device_mismatch", status);
    }
    return {
      state: "bound",
      outcome,
      reason,
      status,
      idempotent: outcome === "already_bound" || report.idempotent === true,
      npub,
      npubStamped,
    };
  }

  return {
    state,
    outcome,
    reason,
    status,
    idempotent: report.idempotent === true,
    npub,
    npubStamped,
  };
}

/**
 * Read a REJECTED invocation. There is no reason code to read: the message is free text from the
 * native layer or from Tauri itself, and guessing "the endpoint is down" out of it would be a claim
 * this layer cannot support. So the app states exactly what it knows — it has no answer.
 */
export function classifyVclawBindError(): VclawBindReport {
  return unreadable("command_unavailable");
}

/**
 * Bind this device to the signed-in principal.
 *
 * NEVER THROWS: a rejected invocation is a state ([`VclawBindReport`] `unreadable`), not an
 * exception, because every caller must DECIDE something about a failed bind and a `catch` that
 * merely falls through is how an app renders an empty estate (A2).
 *
 * Called once per sign-in, after the OIDC callback and BEFORE the first authorised request — see
 * `signInWithVclaw`. Idempotence is the ENDPOINT's property (J1: the row and the device entry are
 * keyed, so a second call writes nothing); [`VclawBindReport.idempotent`] is what reports that it
 * happened.
 */
export async function bindVclawPrincipalDevice(
  devicePubkey: string | null,
): Promise<VclawBindReport> {
  try {
    const raw = await invokeTauri<unknown>(VCLAW_BIND_COMMAND, {});
    return classifyVclawBindReport(raw, devicePubkey);
  } catch {
    return classifyVclawBindError();
  }
}
