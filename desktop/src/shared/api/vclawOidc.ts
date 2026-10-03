import { invokeTauri } from "./tauri";

// ── vclaw IDP OIDC (the `vclaw_oidc_*` commands) ────────────────────────────
//
// Mirrors `desktop/src-tauri/src/commands/vclaw_oidc.rs`.
//
// WHY THIS FILE EXISTS: the three Tauri commands were implemented and compiled
// into the app, but NOTHING IN THE FRONT-END EVER CALLED THEM — so the app
// offered only local key options and there was no way to exercise the vclaw
// IdP from the UI at all. Measured 2026-09-29: `grep -r vclaw src/` returned
// nothing, and `vclaw_oidc_login` had zero call sites.
//
// The endpoints are NOT hard-coded here. The Rust side carries the defaults
// (issuer https://auth.vclawhub.com, client `buzz-desktop`, redirect
// 127.0.0.1/callback, scopes openid profile email groups) and allows each to be
// overridden by environment, so this layer only moves the call across the
// boundary.

/** The account the IdP returns for a completed login. `sub` is REQUIRED by the Rust type. */
export type VclawOidcAccount = {
  // ⚠️ THESE NAMES COME FROM THE **RUST** TYPE, NOT FROM THE OIDC CLAIMS.
  // `VclawOidcAccount` is `#[serde(rename_all = "camelCase")]`, so the Tauri
  // boundary sends `subject` (not `sub`) and `preferredUsername` (not
  // `preferred_username`). Reading the OIDC claim names here yields `undefined`
  // for a REQUIRED field with everything else intact — which is exactly what
  // the first live login produced on 2026-09-29:
  //   "vclaw IdP: logged in as sub=undefined (chance@vchat.email) groups=[...]"
  // A missing required field read as `undefined` instead of raising, so the
  // symptom was a silently wrong string rather than an error.
  subject: string;
  email?: string | null;
  preferredUsername?: string | null;
  groups: string[];
};

/** Run the interactive login (opens the system browser to the IdP). */
export function vclawLogin(): Promise<VclawOidcAccount> {
  return invokeTauri<VclawOidcAccount>("vclaw_oidc_login", {});
}

/** Read an existing session without prompting; `null` when not logged in. */
export function vclawSession(): Promise<VclawOidcAccount | null> {
  return invokeTauri<VclawOidcAccount | null>("vclaw_oidc_session", {});
}

/**
 * The IdP's verdict on the refresh token. Snake_case on the wire: it comes from
 * the Rust enum `vclaw_sign_out::RevocationOutcome`.
 *
 * `revoked` covers "the server says this token is not usable any more", which is
 * also its answer for a token it does not recognise (RFC 7009 §2.2) — it does
 * NOT prove the token was live a moment ago. `rejected` / `unreachable` /
 * `cache_unreadable` all mean the credential was NOT confirmed dead.
 */
export type VclawRevocationOutcome =
  | "revoked"
  | "rejected"
  | "unreachable"
  | "no_cached_token"
  | "cache_unreadable";

/** Mirrors `vclaw_sign_out::VclawSignOutReport` (`camelCase` on the wire). */
export type VclawSignOutReport = {
  /** Did the engine's cache hold a token when it was asked to clear it? */
  hadCachedToken: boolean;
  /** Is the token file gone afterwards? `null` when the path could not be resolved. */
  tokenCacheRemoved: boolean | null;
  revocation: VclawRevocationOutcome;
  /** HTTP status of the revocation POST, when one was sent. */
  revocationStatus: number | null;
  /** One non-sensitive line for the log; never token material. */
  detail: string | null;
};

/**
 * Sign out of vclaw on THIS DEVICE, and revoke the refresh token at the IdP.
 *
 * ⚠️ NON-DESTRUCTIVE, and that is the whole point of it existing: it clears the
 * cached vclaw session under the `vclaw-idp` namespace and nothing else. The
 * identity key, the keyring, the relay session and every local byte stay. The
 * DESTRUCTIVE command is `signOut()` in `./tauriIdentity`, which wipes
 * everything and relaunches into first-run setup.
 *
 * ⚠️ It returns a REPORT, not `void`. The previous signature here declared
 * `Promise<void>` while the Rust command already returned a bool — the declared
 * type hid the only fact that matters after a logout: whether the credential was
 * actually revoked. `revocation !== "revoked" && !== "no_cached_token"` means the
 * refresh token may still be usable, and the UI must not report a clean sign-out.
 */
export function vclawSignOut(): Promise<VclawSignOutReport> {
  return invokeTauri<VclawSignOutReport>("vclaw_oidc_sign_out", {});
}
