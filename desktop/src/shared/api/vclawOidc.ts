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

/** Clear the cached token. */
export function vclawSignOut(): Promise<void> {
  return invokeTauri<void>("vclaw_oidc_sign_out", {});
}
