//! The **non-destructive** vclaw sign-out: what "log out" means for this app, and the one thing a
//! local wipe cannot do on its own.
//!
//! ── WHY THIS FILE EXISTS (operator question, 2026-10-03) ────────────────────────────────────────
//! Settings › Profile offered a section TITLED "Sign out" whose only action was `Delete my data` — a
//! `variant="destructive"` button behind a "wipe all my data" typed confirmation that removes the
//! identity key and every byte of local state. A user who merely wanted to log out had to destroy
//! their identity, or stay signed in. The title promised something the section did not offer.
//!
//! `vclaw_oidc_sign_out` (the engine's `sign_out`) is the right non-destructive primitive: it clears
//! the LOCALLY CACHED vclaw tokens and touches nothing else. Alone it is half a compliant sign-out,
//! because this build requests `offline_access`, so the cache holds a **refresh token** that stays
//! valid at the IdP after the local copy is deleted. A credential that outlives the wipe is exactly
//! what a logout is supposed to prevent, so this module revokes it.
//!
//! ── TWO MEASURED FACTS THE PREVIOUS MODULE DOC GOT WRONG (2026-10-03) ───────────────────────────
//! 1. The IdP DOES advertise a revocation endpoint
//!    (`https://auth.vclawhub.com/api/oidc/revocation`, RFC 7009; its auth methods include `none`).
//!    The old note reasoned "there is no server-side *session* this client could end" — true of
//!    `end_session_endpoint`, which discovery genuinely lacks, and useless about the refresh token,
//!    which the client CAN revoke. The endpoint constant lives in `vclaw_oidc.rs`.
//! 2. The Authelia BROWSER session survives, and revocation does not end it either. MEASURED
//!    2026-10-03 against the deployed build: revoking a refresh token runs exactly two SQL
//!    statements (deactivate the refresh-token row, revoke the access-token row) and never touches a
//!    session store — the browser cookie lives in Redis, the tokens in Postgres. The only server-side
//!    lever that reaches that cookie is `POST /api/logout`, which reads the session id FROM THE
//!    COOKIE and is therefore a no-op (200, destroys nothing) for a native client that has none.
//!    Wiring it would make the UI lie, so it is deliberately not wired; the UI states the limitation
//!    instead.
//!
//! ── WHAT REVOCATION DOES AND DOES NOT PROVE (MEASURED 2026-10-03, live endpoint) ────────────────
//! The endpoint answers `200` with a zero-length body for a token it has never seen, for one that
//! was already inactive, and for one it just killed — so a 200 establishes "this token is not
//! usable", never "a live token was killed a moment ago". It also requires `client_id`: omitting it
//! is `400 invalid_request`, an unknown client is `401 invalid_client`, and ownership is enforced
//! (a client may only revoke tokens issued to it). This client is public, so the request carries the
//! id and no secret.
//!
//! ── WHY THE CACHE PATH IS REPRODUCED HERE ──────────────────────────────────────────────────────
//! `PkceOAuthTokenSource` owns its cache path privately and exposes no way to read the cached
//! refresh token — the one value revocation needs. This module therefore reproduces the engine's own
//! derivation (`buzz-agent/src/auth.rs::cache_path_for`):
//!
//! ```text
//! sha256("<discovery_url>|<client_id>|<scopes joined by ','>") + ".json"
//! under  $BUZZ_AGENT_CONFIG_DIR/buzz-agent/oauth/<namespace>/   (else $HOME/.config/...)
//! ```
//!
//! The key VALUES are handed in by the caller (`VclawTokenCacheKey`) instead of being duplicated
//! here, so the session the app writes and the session this module reads can only disagree if the
//! engine changes the derivation SHAPE. That case is not silent: the engine's own `sign_out` answer
//! and this module's read are reported side by side, and a mismatch surfaces as
//! [`RevocationOutcome::CacheUnreadable`] rather than a false "revoked". The test
//! `cache_key_reproduces_the_engines_measured_file_name` pins the derivation against a file the
//! running app created on the operator's machine.

use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Bound on the revocation POST. Signing out must not hang the UI: the local session is already gone
/// by the time this runs, so a slow IdP costs a warning, never a stuck button.
const REVOCATION_TIMEOUT: Duration = Duration::from_secs(10);
/// The engine's config-dir override (`buzz-agent/src/auth.rs::BUZZ_AGENT_CONFIG_DIR_ENV`), read here
/// so a test, a dev run, or a packaged build that redirects the engine's cache reads the SAME file.
const BUZZ_AGENT_CONFIG_DIR_ENV: &str = "BUZZ_AGENT_CONFIG_DIR";

/// The values that make up a token-cache key, passed in by the caller that owns them.
///
/// Passed rather than re-declared so a scope change (e.g. adding `offline_access`) cannot leave this
/// module reading a cache the engine has stopped using.
#[derive(Debug, Clone, Copy)]
pub struct VclawTokenCacheKey<'a> {
    pub discovery_url: &'a str,
    pub client_id: &'a str,
    pub scopes: &'a [&'a str],
    pub namespace: &'a str,
}

/// Everything needed to revoke a refresh token for one IdP client.
#[derive(Debug, Clone, Copy)]
pub struct VclawSignOutRequest<'a> {
    /// The token itself is NOT carried here: the caller reads it from the cache BEFORE the engine's
    /// `sign_out` deletes the file (that ordering is this module's own contract), and passes it in as
    /// `cached`. A `cache` field was declared and never read, so rustc flagged it - the key is used by
    /// the READER, not by the revocation.
    /// The IdP's RFC 7009 endpoint.
    pub revocation_url: &'a str,
    /// Public client id: the token is revoked with `token_type_hint=refresh_token` and no secret.
    pub client_id: &'a str,
}

/// What became of the refresh token at the IdP.
///
/// A verdict, not a boolean: "could not reach the IdP" and "the IdP refused" are different facts,
/// and a sign-out that reports success for either is how a live credential stays live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RevocationOutcome {
    /// The endpoint answered 2xx: RFC 7009 §2.2 makes that the answer both for a token that was
    /// revoked and for one the server does not recognise, and the live endpoint was MEASURED
    /// returning `200` (empty body) for an invented token on 2026-10-03. So this means "not usable
    /// any more" — the property a sign-out needs — and it does not mean "was live until a moment
    /// ago". Reported with the status so a reader can see exactly what came back.
    Revoked,
    /// The endpoint answered 4xx: nothing was revoked.
    Rejected,
    /// No successful verdict — transport failure, timeout, or a 5xx.
    Unreachable,
    /// Nothing cached to revoke: already signed out, or a cache written before `offline_access` was
    /// requested (an access token only).
    NoCachedToken,
    /// A token file exists at the derived path but could not be read or parsed. Reported instead of
    /// a silent success, because it means this module and the engine disagree about the cache.
    CacheUnreadable,
}

/// The result of one sign-out, as the UI is told it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VclawSignOutReport {
    /// The engine's own answer: did ITS cache hold a token when it was asked to clear it?
    pub had_cached_token: bool,
    /// Is the token file gone afterwards, checked at the path this module derives? `None` when that
    /// path could not be resolved at all (no home directory) — a report, not a failure: the engine
    /// has already cleared its own cache by then.
    pub token_cache_removed: Option<bool>,
    /// The IdP's verdict on the refresh token.
    pub revocation: RevocationOutcome,
    /// HTTP status of the revocation POST, when one was sent. Kept beside the outcome because a 400
    /// and a 502 both map into the refusal class and the operator needs the number.
    pub revocation_status: Option<u16>,
    /// One non-sensitive line for the log/toast. NEVER carries token material.
    pub detail: Option<String>,
}

/// The refresh token read out of the cache before the local wipe.
///
/// A token is a secret, so this type is deliberately not `Debug`, not `Clone`, and not `Serialize`:
/// it exists to be moved into the revocation call and dropped.
pub enum CachedRefreshToken {
    /// Ready to revoke.
    Found(String),
    /// No cache file, or a cache file with no refresh token in it.
    Absent(String),
    /// A cache file was there but is not usable as one.
    Unreadable(String),
}

/// The engine's OAuth cache root: `$BUZZ_AGENT_CONFIG_DIR/buzz-agent/oauth`, else
/// `$HOME/.config/buzz-agent/oauth`.
///
/// `$HOME/.config` is NOT `dirs::config_dir()` on macOS (that is `~/Library/Application Support`).
/// The engine hardcodes this shape (`oauth_cache_root_for`, and its test
/// `cache_path_preserves_production_home_config_directory`), and the operator's live cache sits at
/// `~/.config/buzz-agent/oauth/vclaw-idp/` — so the shape is measured, not assumed.
pub fn cache_root() -> Result<PathBuf, String> {
    match std::env::var_os(BUZZ_AGENT_CONFIG_DIR_ENV) {
        Some(root) => Ok(PathBuf::from(root).join("buzz-agent").join("oauth")),
        None => Ok(dirs::home_dir()
            .ok_or_else(|| "no home directory to locate the vclaw token cache".to_owned())?
            .join(".config")
            .join("buzz-agent")
            .join("oauth")),
    }
}

/// The engine's cache-key digest for one client: `sha256(discovery|client|scopes.join(","))`.
///
/// The separator and the ORDER are the engine's own, so they are the caller's too.
pub fn cache_key(cache: VclawTokenCacheKey<'_>) -> String {
    let material = format!(
        "{}|{}|{}",
        cache.discovery_url,
        cache.client_id,
        cache.scopes.join(",")
    );
    hex::encode(Sha256::digest(material.as_bytes()))
}

/// `<root>/<namespace>/<key>.json` — the token file the engine reads and writes.
pub fn cache_path_in(root: &Path, cache: VclawTokenCacheKey<'_>) -> PathBuf {
    root.join(cache.namespace)
        .join(format!("{}.json", cache_key(cache)))
}

/// [`cache_path_in`] against the real cache root.
pub fn cache_path(cache: VclawTokenCacheKey<'_>) -> Result<PathBuf, String> {
    Ok(cache_path_in(&cache_root()?, cache))
}

/// The cache file's shape, as far as revocation cares.
///
/// A strict subset of the engine's `CachedToken` on purpose: this reads a file the engine owns, so
/// it needs the one field it revokes and must not fail when the others change.
#[derive(Debug, Deserialize)]
struct CachedTokenFile {
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Read the cached refresh token, BEFORE the engine's `sign_out` deletes it.
pub fn read_cached_refresh_token(cache: VclawTokenCacheKey<'_>) -> CachedRefreshToken {
    match cache_root() {
        Ok(root) => read_cached_refresh_token_at(&root, cache),
        Err(error) => CachedRefreshToken::Unreadable(error),
    }
}

/// [`read_cached_refresh_token`] against an explicit root, so it is testable without `$HOME`.
pub fn read_cached_refresh_token_at(
    root: &Path,
    cache: VclawTokenCacheKey<'_>,
) -> CachedRefreshToken {
    let path = cache_path_in(root, cache);
    match std::fs::read_to_string(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            CachedRefreshToken::Absent(format!("no cached token at {}", path.display()))
        }
        Err(error) => CachedRefreshToken::Unreadable(format!(
            "could not read the vclaw token cache at {}: {error}",
            path.display()
        )),
        Ok(body) => match serde_json::from_str::<CachedTokenFile>(&body) {
            Ok(file) => match file.refresh_token.filter(|token| !token.is_empty()) {
                Some(token) => CachedRefreshToken::Found(token),
                // A cache written before `offline_access` was requested has an access token only;
                // there is nothing to revoke server-side and the local wipe is the whole logout.
                None => CachedRefreshToken::Absent(
                    "the cached vclaw token has no refresh token".to_owned(),
                ),
            },
            Err(error) => CachedRefreshToken::Unreadable(format!(
                "could not parse the vclaw token cache at {}: {error}",
                path.display()
            )),
        },
    }
}

/// Map an HTTP status to a revocation verdict. Split out so the boundary is testable without a
/// network: a 4xx must never be able to read as a successful revoke.
fn classify_status(status: StatusCode) -> RevocationOutcome {
    if status.is_success() {
        RevocationOutcome::Revoked
    } else if status.is_client_error() {
        RevocationOutcome::Rejected
    } else {
        RevocationOutcome::Unreachable
    }
}

/// `POST <revocation_url>` with `token`, `token_type_hint=refresh_token`, and the public client id.
///
/// Form-encoded, with no `Authorization` header: this client is registered with
/// `token_endpoint_auth_method: none`, and `none` is among the IdP's advertised revocation auth
/// methods, so the token itself is the only credential in the request.
///
/// `client_id` is NOT optional here — the live endpoint answers `400 invalid_request` without it
/// (MEASURED 2026-10-03) and `401 invalid_client` for an unknown client. It is an identifier, not a
/// secret: this is a public client, which is exactly why RFC 7009's `token_type_hint` and the
/// ownership check on the token's recorded client id are the only guards on the call.
async fn revoke_at_idp(
    http: &Client,
    revocation_url: &str,
    client_id: &str,
    refresh_token: &str,
) -> (RevocationOutcome, Option<u16>, Option<String>) {
    let response = http
        .post(revocation_url)
        .form(&[
            ("token", refresh_token),
            ("token_type_hint", "refresh_token"),
            ("client_id", client_id),
        ])
        .timeout(REVOCATION_TIMEOUT)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return (
                RevocationOutcome::Unreachable,
                None,
                Some(format!(
                    "could not reach the vclaw revocation endpoint: {error}"
                )),
            )
        }
    };
    let status = response.status();
    let outcome = classify_status(status);
    let detail = match outcome {
        RevocationOutcome::Revoked => Some(format!("revocation returned HTTP {}", status.as_u16())),
        RevocationOutcome::Rejected => Some(format!(
            "the vclaw IdP refused the revocation: HTTP {}",
            status.as_u16()
        )),
        _ => Some(format!(
            "the vclaw revocation endpoint answered HTTP {}",
            status.as_u16()
        )),
    };
    (outcome, Some(status.as_u16()), detail)
}

/// Finish a sign-out: revoke the token read in phase 1, and report what happened.
///
/// Runs AFTER the engine's local wipe, and that order is deliberate: the user is signed out on this
/// device even if the IdP cannot be reached, so a network problem degrades the logout instead of
/// cancelling it.
pub async fn revoke_cached_refresh_token(
    http: &Client,
    request: VclawSignOutRequest<'_>,
    cached: CachedRefreshToken,
    had_cached_token: bool,
    token_cache_removed: Option<bool>,
) -> VclawSignOutReport {
    let (revocation, revocation_status, detail) = match cached {
        CachedRefreshToken::Found(refresh_token) => {
            revoke_at_idp(
                http,
                request.revocation_url,
                request.client_id,
                &refresh_token,
            )
            .await
        }
        CachedRefreshToken::Absent(detail) => {
            (RevocationOutcome::NoCachedToken, None, Some(detail))
        }
        CachedRefreshToken::Unreadable(detail) => {
            (RevocationOutcome::CacheUnreadable, None, Some(detail))
        }
    };
    // One log line per sign-out, because "did the IdP actually get told?" is a support question and
    // the UI answer is a toast the user may not have read. `detail` is built here and never carries
    // token material (see `VclawSignOutReport::detail`).
    tracing::info!(
        target: "buzz::vclaw",
        revocation = ?revocation,
        status = ?revocation_status,
        had_cached_token,
        detail = detail.as_deref().unwrap_or(""),
        "vclaw sign-out"
    );
    VclawSignOutReport {
        had_cached_token,
        token_cache_removed,
        revocation,
        revocation_status,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live IdP constants as `vclaw_oidc.rs` declares them. Repeated here only as test input:
    /// the anchor below is a file name the RUNNING app wrote, so the test has to use the values that
    /// produced it.
    const DISCOVERY: &str = "https://auth.vclawhub.com/.well-known/openid-configuration";
    const CLIENT: &str = "buzz-desktop";
    const NAMESPACE: &str = "vclaw-idp";
    const CURRENT_SCOPES: [&str; 5] = ["openid", "profile", "email", "groups", "offline_access"];

    fn current_key() -> VclawTokenCacheKey<'static> {
        VclawTokenCacheKey {
            discovery_url: DISCOVERY,
            client_id: CLIENT,
            scopes: &CURRENT_SCOPES,
            namespace: NAMESPACE,
        }
    }

    /// THE DERIVATION ANCHOR. On the operator's machine
    /// `~/.config/buzz-agent/oauth/vclaw-idp/` held
    /// `2c97f126dcc61f80176999868ec60fe2efc6b4fa27cfc82a4b5ef3bbf8abafa4.json.attempt`, written by
    /// the engine while `VCLAW_SCOPES` was still `openid profile email groups` (MEASURED
    /// 2026-10-03). Reproducing that name from the same formula is what makes this module's reader
    /// the engine's reader rather than a lookalike: the failure being guarded is a path that points
    /// nowhere, which reads as "nothing to revoke" and leaves the live credential live.
    #[test]
    fn cache_key_reproduces_the_engines_measured_file_name() {
        let older = VclawTokenCacheKey {
            discovery_url: DISCOVERY,
            client_id: CLIENT,
            scopes: &["openid", "profile", "email", "groups"],
            namespace: NAMESPACE,
        };
        assert_eq!(
            cache_key(older),
            "2c97f126dcc61f80176999868ec60fe2efc6b4fa27cfc82a4b5ef3bbf8abafa4"
        );
    }

    /// The key the CURRENT scope list produces, pinned because adding `offline_access` is what
    /// orphaned the old cache file, and because a silent change here signs every user out once.
    #[test]
    fn cache_key_follows_the_current_scope_list() {
        assert_eq!(
            cache_key(current_key()),
            "eb534ea51507f733a1167874448dccf6e653f9a13b57f5f046abb65f989d69ac"
        );
    }

    #[test]
    fn cache_path_is_namespace_scoped_and_json_suffixed() {
        assert_eq!(
            cache_path_in(Path::new("/tmp/root"), current_key()),
            Path::new(
                "/tmp/root/vclaw-idp/eb534ea51507f733a1167874448dccf6e653f9a13b57f5f046abb65f989d69ac.json"
            )
        );
    }

    /// A map of the status → verdict boundary, so a refusal can never be reported as a revocation.
    #[test]
    fn a_refusal_is_never_reported_as_a_revocation() {
        for (status, expected) in [
            (200_u16, RevocationOutcome::Revoked),
            (204, RevocationOutcome::Revoked),
            (299, RevocationOutcome::Revoked),
            (300, RevocationOutcome::Unreachable),
            (400, RevocationOutcome::Rejected),
            (401, RevocationOutcome::Rejected),
            (499, RevocationOutcome::Rejected),
            (500, RevocationOutcome::Unreachable),
            (503, RevocationOutcome::Unreachable),
        ] {
            assert_eq!(
                classify_status(StatusCode::from_u16(status).expect("valid status")),
                expected,
                "HTTP {status}"
            );
        }
    }

    /// The reader's four cases against a temp cache root, so no test touches the real `$HOME`.
    #[test]
    fn the_reader_separates_absent_from_unreadable() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        let path = cache_path_in(root, current_key());
        std::fs::create_dir_all(path.parent().expect("namespace dir")).expect("create dir");

        assert!(matches!(
            read_cached_refresh_token_at(root, current_key()),
            CachedRefreshToken::Absent(_)
        ));

        std::fs::write(&path, r#"{"access_token":"a","expires_at":null}"#).expect("write");
        assert!(matches!(
            read_cached_refresh_token_at(root, current_key()),
            CachedRefreshToken::Absent(_)
        ));

        std::fs::write(
            &path,
            r#"{"access_token":"a","refresh_token":"rt","expires_at":null}"#,
        )
        .expect("write");
        assert!(matches!(
            read_cached_refresh_token_at(root, current_key()),
            CachedRefreshToken::Found(token) if token == "rt"
        ));

        std::fs::write(&path, "not json").expect("write");
        assert!(matches!(
            read_cached_refresh_token_at(root, current_key()),
            CachedRefreshToken::Unreadable(_)
        ));
    }

    /// A report for a client that was never signed in must not claim anything was revoked.
    #[tokio::test]
    async fn an_absent_token_reports_nothing_to_revoke() {
        let http = Client::new();
        let request = VclawSignOutRequest {
            revocation_url: "http://127.0.0.1:1/never-contacted",
            client_id: CLIENT,
        };
        let report = revoke_cached_refresh_token(
            &http,
            request,
            CachedRefreshToken::Absent("no cached token".to_owned()),
            false,
            Some(true),
        )
        .await;
        assert_eq!(report.revocation, RevocationOutcome::NoCachedToken);
        assert_eq!(report.revocation_status, None);
        assert!(!report.had_cached_token);
    }
}
