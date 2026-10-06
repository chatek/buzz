//! vclaw IDP sign-in for the desktop: OIDC authorization code + PKCE against
//! `https://auth.vclawhub.com` (Authelia).
//!
//! This is the *account* layer. The desktop's own identity is a Nostr keypair
//! in the OS keyring, and this module never reads it: it does not touch
//! `AppState::keys`, the keyring, or the account -> npub binding
//! (`bind_builderlab_nostr_identity` in `builderlab.rs`), which stays the only
//! thing that may assert "this account is that npub". What this module adds is
//! the IdP's answer to "who signed in", returned to the frontend as
//! [`VclawOidcAccount`], which is the input the identity bridge needs.
//!
//! Mechanics are the shared engine, not a second implementation:
//! `buzz_agent_pkg::auth::PkceOAuthTokenSource` does RFC 8414 discovery, RFC
//! 7636 PKCE (S256), the loopback listener, the code exchange, on-disk caching
//! and silent refresh. The desktop contributes the browser opener (Tauri's) and
//! the loopback shape the IdP actually accepts.
//!
//! MEASURED 2026-09-20 against the live IdP (recorded on
//! `buzz_agent_pkg::auth::PkceLoopbackConfig`): a registered loopback redirect
//! is accepted on `127.0.0.1` with *any* port, while the host string `localhost`
//! and a different path are rejected with 400 `invalid_request`. So the client
//! id below must be registered with `http://127.0.0.1/callback` and the client
//! must send exactly that host and path.

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use buzz_agent_pkg::auth::{
    AuthError, AuthIntent, BrowserOpener, PkceLoopbackConfig, PkceOAuthConfig, PkceOAuthTokenSource,
};

use crate::app_state::AppState;
use crate::commands::vclaw_sign_out::{
    revoke_cached_refresh_token, VclawSignOutReport, VclawSignOutRequest, VclawTokenCacheKey,
};

/// Issuer of the vclaw IDP (Authelia v4.38.0). Discovery is RFC 8414, one
/// document under the issuer.
const VCLAW_DISCOVERY_URL: &str = "https://auth.vclawhub.com/.well-known/openid-configuration";
/// Public client id registered for this app. No secret exists, so the token
/// endpoint is called with `token_endpoint_auth_method: none` and PKCE is the
/// only proof of possession.
const VCLAW_CLIENT_ID: &str = "buzz-desktop";
/// Registered redirect host. Literal: `localhost` is rejected by this IdP.
const VCLAW_REDIRECT_HOST: &str = "127.0.0.1";
/// Registered redirect path. Literal: any other path is rejected. The port is
/// chosen at runtime (`:0`), which the IdP accepts on loopback.
const VCLAW_REDIRECT_PATH: &str = "/callback";
/// Scopes the registered client must be granted. `groups` is what makes the
/// IdP usable as an authorization source later.
// `offline_access` is REQUIRED for the silent refresh: the IdP's own registration note says
// "`offline_access` + the refresh_token grant are required for the engine's cached-token refresh;
// without the scope every expiry re-prompts" (authelia configuration.yml, the buzz-desktop block).
// It is registered for this client, so the omission was ours, not the IdP's. Adding it changes
// `sha256(discovery_url|client_id|scopes)`, the token-cache key below, which signs the user out
// once - intended, and free on a fresh build.
const VCLAW_SCOPES: [&str; 5] = ["openid", "profile", "email", "groups", "offline_access"];
/// Cache directory under the platform config dir, keyed by this client, so the
/// vclaw session can never collide with a Databricks one.
const VCLAW_CACHE_NAMESPACE: &str = "vclaw-idp";
/// Human budget for the sign-in page: a password plus a second factor. The
/// engine still caps the whole locked attempt at its own
/// `AUTH_ATTEMPT_DEADLINE` (150s), so a longer value here only spends budget
/// the attempt would otherwise leave unused.
const VCLAW_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
/// `userinfo_endpoint`, read off the IdP's own discovery document
/// (MEASURED 2026-09-20). Used with the access token to learn which account
/// signed in.
const VCLAW_USERINFO_URL: &str = "https://auth.vclawhub.com/api/oidc/userinfo";
/// Per-request bound for the userinfo call. The engine owns the token
/// endpoint's timeouts; this one is ours.
const VCLAW_USERINFO_TIMEOUT: Duration = Duration::from_secs(15);
/// RFC 7009 token revocation endpoint, read off the IdP's own discovery document
/// (MEASURED 2026-10-03):
///
/// ```text
/// "revocation_endpoint": "https://auth.vclawhub.com/api/oidc/revocation"
/// "revocation_endpoint_auth_methods_supported": [..., "none"]
/// ```
///
/// The same document has NO `end_session_endpoint`. That absence is what made the
/// earlier reading of this IdP — "there is no server-side session this client
/// could end" — true about the Authelia browser session and WRONG about the
/// refresh token: a token is revocable even when a session is not. With
/// `offline_access` in `VCLAW_SCOPES`, that refresh token outlives any local
/// wipe, so a sign-out that only clears the cache leaves a live credential.
const VCLAW_REVOCATION_URL: &str = "https://auth.vclawhub.com/api/oidc/revocation";

/// Opens the sign-in page in the system browser.
///
/// The engine calls this while its loopback listener is already bound, so it
/// must not block: `open_url` hands the URL to the OS and returns. A hand-off
/// failure is reported so the engine can fail the attempt instead of waiting
/// for a redirect nobody can send.
struct TauriBrowserOpener {
    app: AppHandle,
}

impl BrowserOpener for TauriBrowserOpener {
    fn open(&self, url: &str) -> Result<(), String> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| error.to_string())
    }
}

/// The vclaw account behind a live session.
///
/// This is the *account* identity, not the desktop's Nostr identity: bind the
/// two (challenge -> signature -> verify) before treating them as one person.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VclawOidcAccount {
    /// Provider-side subject (`sub`): stable per account per client.
    pub subject: String,
    /// A missing optional claim is an IdP/client-configuration difference, not
    /// a client error, so these stay optional rather than failing the login.
    pub email: Option<String>,
    pub preferred_username: Option<String>,
    /// Group claims the client was granted. Empty when none were granted.
    pub groups: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct VclawUserInfoClaims {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
}

/// The engine's failures are typed and stable, but its display text is
/// Databricks-worded (it is shared with the LLM transport). The desktop
/// therefore formats its own copy from the stable code, as the engine's
/// `AuthError::code` documentation intends.
fn vclaw_auth_error(error: AuthError) -> String {
    match error {
        AuthError::NoCredential => "not signed in to vclaw".to_owned(),
        AuthError::Denied => "vclaw sign-in was denied".to_owned(),
        AuthError::TimedOut => "vclaw sign-in timed out; try again".to_owned(),
        AuthError::BrowserOpenFailed => "could not open a browser for vclaw sign-in".to_owned(),
        AuthError::NetworkUnavailable => "could not reach the vclaw IDP".to_owned(),
        AuthError::RefreshRejected => "the vclaw session expired; sign in again".to_owned(),
        AuthError::ExchangeFailed => "the vclaw IDP rejected the sign-in code".to_owned(),
        AuthError::LockTimeout => "another vclaw sign-in is already in progress".to_owned(),
    }
}

fn vclaw_config() -> PkceOAuthConfig {
    PkceOAuthConfig {
        discovery_url: VCLAW_DISCOVERY_URL.to_owned(),
        client_id: VCLAW_CLIENT_ID.to_owned(),
        scopes: VCLAW_SCOPES
            .iter()
            .map(|scope| (*scope).to_owned())
            .collect(),
        cache_namespace: VCLAW_CACHE_NAMESPACE.to_owned(),
        cache_dir_override: None,
    }
}

/// THE ONE vclaw SIGN-IN ENGINE for this process. This cell is a CORRECTNESS requirement, not an
/// optimisation, and removing it re-breaks device binding.
///
/// ⚠ WHY IT EXISTS — MEASURED 2026-10-04, from a live user report. `vclaw_oidc_login` and
/// `vclaw_principal_bind` each called this function, and it built a NEW `PkceOAuthTokenSource` every
/// time. The OIDC `id_token` lives in a **MEMORY-ONLY** field of that engine and is deliberately
/// never written to the on-disk cache (see `buzz_agent_pkg::auth`). So the interactive sign-in
/// populated instance A, the bind read instance B whose holder is `None` on construction, and the
/// bind answered `idp_unreachable` / `no_id_token` — while the user was in fact signed in, with a
/// valid unexpired access token on disk and `"result":"ok"` in the engine's own attempt sidecar.
///
/// The user-visible effect was a bind gate that said "you are not signed in on this device" no
/// matter how many times they signed in, because the credential was discarded between two commands
/// of the same running app.
///
/// The ACCESS token does not need this — it is cached on disk and keyed by
/// `sha256(discovery_url|client_id|scopes)`. The `id_token` does, and the `id_token` is the
/// credential the bind's whole contract rests on. The cache key still means a scope change signs
/// everyone out once, exactly as documented; that is unaffected by this change.
static VCLAW_ENGINE: OnceLock<Arc<PkceOAuthTokenSource>> = OnceLock::new();

/// Build (once) and return the vclaw token source bound to this app's browser opener.
pub(crate) fn vclaw_source(app: AppHandle) -> Result<Arc<PkceOAuthTokenSource>, String> {
    if let Some(existing) = VCLAW_ENGINE.get() {
        return Ok(existing.clone());
    }
    let loopback = PkceLoopbackConfig::new(
        VCLAW_REDIRECT_HOST,
        VCLAW_REDIRECT_PATH,
        VCLAW_PROMPT_TIMEOUT,
    );
    let engine = PkceOAuthTokenSource::new_with_loopback(
        vclaw_config(),
        Arc::new(TauriBrowserOpener { app }),
        loopback,
    )
    .map_err(|error| format!("could not prepare vclaw sign-in: {error}"))?;
    // `set` can lose a race to another caller; if it does, the winner is the one true engine and we
    // hand that back rather than a second instance that would reintroduce the split above.
    let _ = VCLAW_ENGINE.set(engine);
    VCLAW_ENGINE
        .get()
        .cloned()
        .ok_or_else(|| "could not prepare vclaw sign-in: engine not initialised".to_owned())
}

/// Ask the IdP which account an access token belongs to.
///
/// The access token is also the seam for everything that will later attach an
/// IdP credential to a relay call; nothing in this module sends it anywhere but
/// the IdP's own userinfo endpoint.
async fn account_for_token(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<VclawOidcAccount, String> {
    let response = http
        .get(VCLAW_USERINFO_URL)
        .bearer_auth(access_token)
        .timeout(VCLAW_USERINFO_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("could not reach the vclaw IDP: {error}"))?;
    // A 401 proves the cached token is dead even though the local expiry clock
    // disagreed. That is a credential outcome, not a network fault, so it says
    // "sign in again" rather than "try later".
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("the vclaw session expired; sign in again".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!(
            "vclaw userinfo failed with HTTP {}",
            response.status()
        ));
    }
    let claims: VclawUserInfoClaims = response
        .json()
        .await
        .map_err(|error| format!("invalid vclaw userinfo response: {error}"))?;
    Ok(VclawOidcAccount {
        subject: claims.sub,
        email: claims.email,
        preferred_username: claims.preferred_username,
        groups: claims.groups,
    })
}

/// Sign in to the vclaw IDP, opening a browser when the cache cannot satisfy
/// the request.
///
/// `UserInitiated` is what makes this an explicit human action: the engine allows
/// the browser and clears any failure cooldown, so a previous timeout cannot
/// swallow the click.
#[tauri::command]
pub async fn vclaw_oidc_login(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<VclawOidcAccount, String> {
    let source = vclaw_source(app)?;
    let access_token = source
        .acquire_with_intent(AuthIntent::UserInitiated, None)
        .await
        .map_err(vclaw_auth_error)?;
    account_for_token(&state.http_client, &access_token).await
}

/// Report the current session without opening a browser: `None` means "not
/// signed in", not "error".
///
/// `Headless` is the engine's guarantee that this probe never pops a window, so
/// a background call (app start, settings panel) is safe.
#[tauri::command]
pub async fn vclaw_oidc_session(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<VclawOidcAccount>, String> {
    let source = vclaw_source(app)?;
    match source.acquire_with_intent(AuthIntent::Headless, None).await {
        Ok(access_token) => account_for_token(&state.http_client, &access_token)
            .await
            .map(Some),
        Err(AuthError::NoCredential) => Ok(None),
        Err(error) => Err(vclaw_auth_error(error)),
    }
}

/// The engine's token-cache key for this app, as VALUES: the same four
/// constants this module signs in with.
///
/// Handed to `vclaw_sign_out` rather than re-declared there, so the cache this
/// command reads and the cache the engine writes can only disagree if the engine
/// changes the derivation SHAPE — and that disagreement is reported (see
/// `vclaw_sign_out::RevocationOutcome::CacheUnreadable`), never assumed away.
fn vclaw_token_cache_key() -> VclawTokenCacheKey<'static> {
    VclawTokenCacheKey {
        discovery_url: VCLAW_DISCOVERY_URL,
        client_id: VCLAW_CLIENT_ID,
        scopes: &VCLAW_SCOPES,
        namespace: VCLAW_CACHE_NAMESPACE,
    }
}

/// Sign out of the vclaw IDP: the NON-DESTRUCTIVE logout.
///
/// This is the command behind the `Sign out` button in Settings > Profile, and
/// it is deliberately the small one. It touches nothing but the cached vclaw
/// credential:
///
/// 1. Read the cached refresh token, BEFORE the wipe — step 2 deletes the file
///    the value lives in, and the engine exposes no way to hand the token out.
/// 2. Clear the local vclaw session through the engine's `sign_out`: the token
///    file plus the cooldown/attempt sidecars under the `vclaw-idp` namespace,
///    and the in-memory cell. The advisory lock file stays, because the engine
///    never unlinks a lock another process may hold.
/// 3. Revoke the refresh token at the IdP (RFC 7009) and report the verdict.
///
/// The identity key, the OS keyring, the relay session, the community config and
/// every other local byte are OUT of scope: that separation is what makes this a
/// logout rather than the destructive `sign_out` (wipe everything, relaunch into
/// first-run setup) that still sits beside it in the same section.
///
/// The IdP advertises no `end_session_endpoint`, so the Authelia BROWSER session
/// cannot be ended by this client at all — it is a cookie in whatever browser
/// ran the sign-in. The Settings copy states that; this command must not imply
/// otherwise.
///
/// Returns a report rather than a bool: "the cache was cleared" and "the IdP was
/// told" are different facts, and only the second stops the credential outliving
/// the wipe.
#[tauri::command]
pub async fn vclaw_oidc_sign_out(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<VclawSignOutReport, String> {
    let cache = vclaw_token_cache_key();
    let cached = crate::commands::vclaw_sign_out::read_cached_refresh_token(cache);

    let source = vclaw_source(app)?;
    let had_cached_token = source
        .sign_out()
        .await
        .map_err(|error| format!("could not clear the vclaw session: {error}"))?;

    // Checked AFTER the wipe, at the path this module derives, so "signed out"
    // is a filesystem fact rather than an assumption about the engine.
    let token_cache_removed = crate::commands::vclaw_sign_out::cache_path(cache)
        .ok()
        .map(|path| !path.exists());

    Ok(revoke_cached_refresh_token(
        &state.http_client,
        VclawSignOutRequest {
            revocation_url: VCLAW_REVOCATION_URL,
            client_id: VCLAW_CLIENT_ID,
        },
        cached,
        had_cached_token,
        token_cache_removed,
    )
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠ THIS FILE HELD **ZERO** TESTS UNTIL 2026-10-06, WHILE ITS SIBLINGS HELD 22 BETWEEN THEM
    /// (`vclaw_principal_bind.rs`: 16, `vclaw_sign_out.rs`: 6). **AND THE TWO COMMANDS THAT LIVE HERE —
    /// `vclaw_oidc_login` (:265) and `vclaw_oidc_session` (:283) — ARE THE TWO THAT *ESTABLISH THE IDP SESSION*,
    /// the part of the integration a reviewer would most want covered.** MEASURED, not assumed: the desktop e2e
    /// specs that exercise them (`vclaw-signin-only`, `onboarding`) **STUB** the Tauri command, so what they prove
    /// is the UI's CONTRACT, not this file's behaviour.
    ///
    /// The tests below cover the PURE surface — the three functions that take no `AppHandle` and touch no network.
    /// The interactive login itself cannot be unit-tested here; these tests hold down the CONFIGURATION CONTRACT
    /// it is built from, which is the part that fails silently when it drifts.

    // ---------------------------------------------------------------- vclaw_config / cache key AGREE
    //
    // ★ THE INVARIANT WORTH PINNING IS A CROSS-CHECK, NOT A LITERAL. `vclaw_config()` builds the engine's OIDC
    //   config and `vclaw_token_cache_key()` builds the key for the cache the sign-out path reads. BOTH derive
    //   `discovery_url`, `client_id` and `scopes` from the same constants — and the file's own comment at :300-303
    //   says why that matters:
    //       "the cache this command reads and the cache the engine writes can only disagree if the engine changes
    //        the derivation SHAPE — and that disagreement is reported, never assumed away."
    //   ⇒ THESE TWO MUST NOT DESCRIBE DIFFERENT IDENTITY PROVIDERS. A drift between them is exactly the shape of
    //     the 2026-10-04 device-binding bug documented at :172-190: a credential silently lost between two
    //     derivations that were supposed to describe the same thing.
    // ★ AND THIS TEST NEEDS NO ANCHOR FILE — it compares two things in THIS file against each other, so it cannot
    //   go stale the way a duplicated-literal assertion can.

    #[test]
    fn config_and_cache_key_describe_the_same_identity_provider() {
        let config = vclaw_config();
        let key = vclaw_token_cache_key();

        assert_eq!(
            config.discovery_url, key.discovery_url,
            "the engine's discovery URL and the cache key's discovery URL must not diverge"
        );
        assert_eq!(
            config.client_id, key.client_id,
            "the engine's client id and the cache key's client id must not diverge"
        );
        // ⚠ THE TWO `scopes` FIELDS ARE DIFFERENT TYPES AND CANNOT BE COMPARED DIRECTLY:
        //   `PkceOAuthConfig.scopes`    = Vec<String>       (auth.rs:318)
        //   `VclawTokenCacheKey.scopes` = &'a [&'a str]     (vclaw_sign_out.rs:79)
        // ⇒ COMPARE THE ELEMENTS, not the containers. `assert_eq!(config.scopes, key.scopes)` does NOT compile,
        //   and I found that by READING the two declarations rather than by a failed build.
        let config_scopes: Vec<&str> = config.scopes.iter().map(String::as_str).collect();
        assert_eq!(
            config_scopes,
            key.scopes.to_vec(),
            "a scope change must invalidate the cache ONCE and identically for both derivations"
        );
        assert_eq!(config.cache_namespace, key.namespace);
    }

    #[test]
    fn config_pins_the_vclaw_idp_endpoints_and_scope_set() {
        let config = vclaw_config();
        // Literals on purpose: these are the values the LIVE IDP was registered for, and a change to any of
        // them is a re-registration event, not a refactor. Pinning them here makes that visible in review.
        assert_eq!(
            config.discovery_url,
            "https://auth.vclawhub.com/.well-known/openid-configuration"
        );
        assert_eq!(config.client_id, "buzz-desktop");
        assert_eq!(config.cache_namespace, "vclaw-idp");
        assert_eq!(
            config.scopes,
            vec![
                "openid".to_owned(),
                "profile".to_owned(),
                "email".to_owned(),
                "groups".to_owned(),
                "offline_access".to_owned(),
            ],
            "offline_access is what makes silent refresh possible; dropping it is a behaviour change"
        );
        assert!(
            config.cache_dir_override.is_none(),
            "an override would move the cache the sign-out path reads"
        );
    }

    #[test]
    fn config_scopes_are_not_empty_and_have_no_duplicates() {
        let scopes = vclaw_config().scopes;
        assert!(!scopes.is_empty());
        let mut sorted = scopes.clone();
        sorted.sort();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(
            before,
            sorted.len(),
            "a duplicate scope is a typo, not a request"
        );
    }

    // ---------------------------------------------------------------- vclaw_auth_error
    //
    // ★ A COMPLETE MATCH OVER EIGHT VARIANTS, EACH WITH ITS OWN USER-FACING STRING. The failure this catches is
    //   not a missing arm (the match is exhaustive, so that will not compile) — it is **A COPIED ARM**: two
    //   variants mapping to the same text, so a user is told "sign-in timed out" when the network was down.
    //   That is a diagnosability regression that compiles perfectly and passes review.

    #[test]
    fn every_auth_error_maps_to_a_distinct_nonempty_message() {
        let cases = [
            AuthError::NoCredential,
            AuthError::Denied,
            AuthError::TimedOut,
            AuthError::BrowserOpenFailed,
            AuthError::NetworkUnavailable,
            AuthError::RefreshRejected,
            AuthError::ExchangeFailed,
            AuthError::LockTimeout,
        ];
        // ⚠ `AuthError` derives Debug, Clone, PartialEq, Eq - ***NOT Copy*** (auth.rs:122) - so this must
        //   clone rather than dereference. `vclaw_auth_error(*e)` does NOT compile.
        let messages: Vec<String> = cases.iter().map(|e| vclaw_auth_error(e.clone())).collect();

        for (i, message) in messages.iter().enumerate() {
            assert!(
                !message.trim().is_empty(),
                "variant {i} maps to an empty message"
            );
        }
        let mut unique = messages.clone();
        unique.sort();
        let total = unique.len();
        unique.dedup();
        assert_eq!(
            total,
            unique.len(),
            "two AuthError variants map to the SAME text: {messages:?}"
        );
    }

    #[test]
    fn auth_error_messages_name_vclaw_so_the_user_knows_which_identity_provider_failed() {
        // The app talks to more than one identity provider; a message that does not say "vclaw" costs the user
        // the first step of diagnosis. Only the variants where a user is mid-flow are checked, because the
        // variants that describe an internal state (no credential) are surfaced in a different context.
        for error in [
            AuthError::Denied,
            // (AuthError is Clone, not Copy - the iteration below clones from this array)
            AuthError::TimedOut,
            AuthError::BrowserOpenFailed,
            AuthError::NetworkUnavailable,
            AuthError::RefreshRejected,
            AuthError::ExchangeFailed,
            AuthError::LockTimeout,
        ] {
            let message = vclaw_auth_error(error.clone());
            assert!(
                message.contains("vclaw"),
                "{error:?} produced a message that does not name the provider: {message:?}"
            );
        }
    }
}
