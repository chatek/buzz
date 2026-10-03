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

use std::{sync::Arc, time::Duration};

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

/// Build a token source for the vclaw IDP bound to this app's browser opener.
///
/// Cheap and stateless on the desktop side: the engine reads/writes its own
/// on-disk cache and serializes concurrent callers, so no session state is
/// parked in `AppState`. The cache is keyed by
/// `sha256(discovery_url|client_id|scopes)`, so a scope change signs everyone
/// out once — which is the intended behavior, not a bug to work around.
pub(crate) fn vclaw_source(app: AppHandle) -> Result<Arc<PkceOAuthTokenSource>, String> {
    let loopback = PkceLoopbackConfig::new(
        VCLAW_REDIRECT_HOST,
        VCLAW_REDIRECT_PATH,
        VCLAW_PROMPT_TIMEOUT,
    );
    PkceOAuthTokenSource::new_with_loopback(
        vclaw_config(),
        Arc::new(TauriBrowserOpener { app }),
        loopback,
    )
    .map_err(|error| format!("could not prepare vclaw sign-in: {error}"))
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
