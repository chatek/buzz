use std::{collections::HashMap, sync::Mutex, time::Duration};

use axum::{
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;

const BUILDERLAB_API_BASE_URL: &str = "https://app.builderlab.xyz/api/goose";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const BB_SESSION_CREDENTIAL_HEADER: &str = "X-BB-Session-Credential";
// Builderlab enforces an Origin check on the identity bind endpoints. Browsers
// attach this automatically; the desktop reqwest client must set it explicitly
// or challenge/verify fail with `invalid_origin`. It also seeds the challenge
// body's `origin` field so both agree.
const BUILDERLAB_ORIGIN: &str = "https://app.builderlab.xyz";
const AUTH_COMPLETE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Buzz authentication complete</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #231e1e;
      background: #d7d72e;
    }

    * {
      box-sizing: border-box;
    }

    body {
      min-height: 100vh;
      min-height: 100dvh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background-color: #d7d72e;
      background-image: radial-gradient(circle, rgba(35, 30, 30, 0.16) 1.2px, transparent 1.3px);
      background-size: 37px 37px;
    }

    main {
      width: min(100%, 560px);
      padding: clamp(32px, 8vw, 64px);
      border: 2px solid #231e1e;
      border-radius: 28px;
      background: #d7e7f6;
      box-shadow: 8px 8px 0 #231e1e;
    }

    .bee {
      display: block;
      width: 72px;
      height: auto;
      margin-bottom: 40px;
      color: #231e1e;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      margin: 0 0 20px;
      padding: 6px 14px;
      border-radius: 999px;
      background: #d7d72e;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }

    h1 {
      max-width: 440px;
      margin: 0;
      font-size: clamp(40px, 9vw, 64px);
      font-weight: 600;
      letter-spacing: -0.055em;
      line-height: 0.95;
    }

    p {
      max-width: 390px;
      margin: 24px 0 0;
      font-size: 18px;
      letter-spacing: -0.02em;
      line-height: 1.45;
    }

    @media (max-width: 480px) {
      body {
        padding: 16px;
      }

      main {
        padding: 32px 28px 36px;
        border-radius: 22px;
        box-shadow: 6px 6px 0 #231e1e;
      }

      .bee {
        width: 60px;
        margin-bottom: 32px;
      }
    }
  </style>
</head>
<body>
  <main>
    <svg class="bee" viewBox="0 0 466 309" role="img" aria-label="Buzz">
      <defs>
        <mask id="bee-mask">
          <rect width="466" height="309" fill="black"/>
          <circle cx="91.7" cy="154.5" r="91.7" fill="white"/>
          <circle cx="374.3" cy="154.5" r="91.7" fill="white"/>
          <rect x="128" width="210" height="309" rx="34" fill="white"/>
          <ellipse cx="193.3" cy="84.4" rx="27" ry="27" fill="black"/>
          <ellipse cx="276" cy="84.4" rx="27" ry="27" fill="black"/>
          <rect x="166.3" y="157.2" width="136.9" height="38.3" rx="5" fill="black"/>
          <rect x="166.9" y="235.1" width="136.2" height="37.6" rx="5" fill="black"/>
        </mask>
      </defs>
      <rect width="466" height="309" fill="currentColor" mask="url(#bee-mask)"/>
    </svg>
    <div class="eyebrow">Authentication complete</div>
    <h1>You&rsquo;re signed in.</h1>
    <p>You can close this window and return to Buzz.</p>
  </main>
</body>
</html>"#;

#[derive(Default)]
pub(crate) struct BuilderlabSession(Mutex<Option<StoredSession>>);

#[derive(Default)]
pub(crate) struct BuilderlabLogin(Mutex<Option<PendingLogin>>);

struct PendingLogin {
    id: uuid::Uuid,
    cancel: oneshot::Sender<()>,
}

struct StoredSession {
    credential: String,
}

#[derive(Debug, Deserialize)]
struct LoginExchangeResponse {
    session_credential: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuilderlabAuthInfo {
    expires_at: String,
    email: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthMeResponse {
    email: Option<String>,
    name: Option<String>,
    expires_at: String,
}

struct CallbackState {
    nonce: String,
    sender: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
}

async fn login_callback(
    Path(nonce): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    AxumState(state): AxumState<std::sync::Arc<CallbackState>>,
) -> Response {
    if nonce != state.nonce {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }

    let result = match query.get("code").filter(|code| !code.is_empty()) {
        Some(code) => Ok(code.clone()),
        None => Err(query
            .get("error_description")
            .or_else(|| query.get("error"))
            .cloned()
            .unwrap_or_else(|| "Authentication callback did not include a code".to_owned())),
    };
    if let Some(sender) = state
        .sender
        .lock()
        .expect("callback sender poisoned")
        .take()
    {
        let _ = sender.send(result);
    }

    Html(AUTH_COMPLETE_HTML).into_response()
}

fn api_url(path: &str) -> Result<Url, String> {
    Url::parse(&format!("{BUILDERLAB_API_BASE_URL}{path}"))
        .map_err(|error| format!("invalid Builderlab API URL: {error}"))
}

fn login_url(return_to: &str) -> Result<Url, String> {
    let mut login_url = api_url("/v1/auth/login")?;
    login_url
        .query_pairs_mut()
        .append_pair("type", "cli")
        .append_pair("product", "buzz")
        .append_pair("returnTo", return_to);
    Ok(login_url)
}

async fn authenticated_user(
    client: &reqwest::Client,
    credential: &str,
) -> Result<AuthMeResponse, String> {
    let response = client
        .get(api_url("/v1/auth/me")?)
        .header(BB_SESSION_CREDENTIAL_HEADER, credential)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| format!("Builderlab session check failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Builderlab session check failed with HTTP {}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("invalid Builderlab session response: {error}"))
}

#[tauri::command]
pub(crate) async fn start_builderlab_login(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
    login: tauri::State<'_, BuilderlabLogin>,
) -> Result<BuilderlabAuthInfo, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("could not start local authentication callback: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("could not read local authentication callback: {error}"))?
        .port();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let return_to = format!("http://127.0.0.1:{port}/callback/{nonce}");
    let (sender, receiver) = oneshot::channel();
    let callback_state = std::sync::Arc::new(CallbackState {
        nonce: nonce.clone(),
        sender: Mutex::new(Some(sender)),
    });
    let router = Router::new()
        .route("/callback/{nonce}", get(login_callback))
        .with_state(callback_state);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let login_url = login_url(&return_to)?;
    if let Err(error) = app.opener().open_url(login_url.as_str(), None::<&str>) {
        server.abort();
        return Err(format!("could not open Builderlab authentication: {error}"));
    }

    let login_id = uuid::Uuid::new_v4();
    let (cancel_sender, mut cancel_receiver) = oneshot::channel();
    {
        let mut pending = login.0.lock().map_err(|error| error.to_string())?;
        if let Some(previous) = pending.take() {
            let _ = previous.cancel.send(());
        }
        *pending = Some(PendingLogin {
            id: login_id,
            cancel: cancel_sender,
        });
    }

    let exchange_code = tokio::select! {
        result = tokio::time::timeout(LOGIN_TIMEOUT, receiver) => match result {
            Ok(Ok(Ok(code))) => code,
            Ok(Ok(Err(error))) => {
                server.abort();
                return Err(error);
            }
            Ok(Err(_)) => {
                server.abort();
                return Err("local authentication callback stopped unexpectedly".to_owned());
            }
            Err(_) => {
                server.abort();
                return Err("Builderlab authentication timed out".to_owned());
            }
        },
        _ = &mut cancel_receiver => {
            server.abort();
            return Err("Builderlab authentication canceled".to_owned());
        }
    };
    server.abort();

    let response = app_state
        .http_client
        .post(api_url("/v1/auth/login/exchange")?)
        .json(&serde_json::json!({ "code": exchange_code }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| format!("Builderlab code exchange failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Builderlab code exchange failed with HTTP {}",
            response.status()
        ));
    }
    let exchanged: LoginExchangeResponse = response
        .json()
        .await
        .map_err(|error| format!("invalid Builderlab code exchange response: {error}"))?;
    if exchanged.session_credential.is_empty() {
        return Err("Builderlab code exchange returned an empty credential".to_owned());
    }

    let me = authenticated_user(&app_state.http_client, &exchanged.session_credential).await?;
    if exchanged.expires_at != me.expires_at {
        return Err("Builderlab session expiry did not match code exchange".to_owned());
    }
    let info = BuilderlabAuthInfo {
        expires_at: me.expires_at.clone(),
        email: me.email,
        name: me.name,
    };
    {
        let mut pending = login.0.lock().map_err(|error| error.to_string())?;
        if pending
            .as_ref()
            .is_none_or(|pending| pending.id != login_id)
        {
            return Err("Builderlab authentication canceled".to_owned());
        }
        *pending = None;
    }
    *session.0.lock().map_err(|error| error.to_string())? = Some(StoredSession {
        credential: exchanged.session_credential,
    });
    Ok(info)
}

#[tauri::command]
pub(crate) async fn get_builderlab_auth(
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<Option<BuilderlabAuthInfo>, String> {
    let stored = session
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(|stored| stored.credential.clone());
    let Some(credential) = stored else {
        return Ok(None);
    };
    match authenticated_user(&app_state.http_client, &credential).await {
        Ok(me) => Ok(Some(BuilderlabAuthInfo {
            expires_at: me.expires_at,
            email: me.email,
            name: me.name,
        })),
        Err(error) => {
            *session
                .0
                .lock()
                .map_err(|lock_error| lock_error.to_string())? = None;
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_builderlab_login(
    login: tauri::State<'_, BuilderlabLogin>,
) -> Result<(), String> {
    if let Some(pending) = login.0.lock().map_err(|error| error.to_string())?.take() {
        let _ = pending.cancel.send(());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_builderlab_auth(
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<(), String> {
    *session.0.lock().map_err(|error| error.to_string())? = None;
    Ok(())
}

// ── Identity-class requests: NIP-98, never a Builderlab session ──────────────
//
// RULING A OF THE AGENTS SPRINT (2026-10-02). The `.../nostr-identities/*` calls
// below used to travel to the vendor host carrying the Builderlab SESSION
// credential (`X-BB-Session-Credential`, BB_SESSION_CREDENTIAL_HEADER above). They
// no longer do, and the reason is the swap's own reason:
//
//   * a permanent second credential path keeps a third party (Builderlab) inside
//     vclaw's trust chain, which is what the swap exists to end;
//   * the estate is already Schnorr-native on the verifying side — BIP-340 over the
//     event id — so ONE credential class covers the relay AND identity;
//   * two credential paths double the audit surface.
//
// So an identity request is authenticated by the user's OWN identity key signing a
// kind-27235 event, sent as `Authorization: Nostr <base64(event)>`: byte for byte the
// header `crate::relay::build_nip98_auth_header_for_keys` already builds for
// `POST /query` and `POST /events`, and the header the estate's verifier reads
// (vgate `buzzid.NIP98Gate`, restated from
// buzz-gateway/internal/api/auth_nip98.go). This is a transport change, not a new
// protocol.
//
// The estate NEVER accepted the session credential, so there is no dual-credential
// window on the server: the only place the retired path could survive is an old
// app binary, and old binaries simply keep talking to the vendor. That is why the
// transition window below is a CLIENT release window and nothing else.
//
// The three identity commands therefore take NO `BuilderlabSession`. That parameter
// is not merely unused — dropping it is what makes "an identity call cannot carry the
// vendor session" a property of the type system instead of a promise.
const IDENTITY_CURRENT_PATH: &str = "/v1/buzz/nostr-identities/current";
const IDENTITY_CHALLENGE_PATH: &str = "/v1/buzz/nostr-identities/challenge";
const IDENTITY_VERIFY_PATH: &str = "/v1/buzz/nostr-identities/verify";
const IDENTITY_DELETE_PATH: &str = "/v1/buzz/nostr-identities/delete";

/// The ESTATE's identity base URL — the origin that serves the relay AND
/// `/v1/buzz/*` (services/nginx/buzz.vclawhub.com.conf `location /v1/buzz` →
/// vgate:8081), derived from the app's own relay configuration.
///
/// Deriving it instead of hard-coding a host is deliberate: the identity path then
/// cannot drift to a second host, and a workspace relay override moves the relay and
/// identity together. `relay_api_base_url_with_override` is the same function the
/// `/query` bridge uses, so "which estate am I talking to" has one answer.
fn identity_url_from_base(base: &str, path: &str) -> Result<Url, String> {
    Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
        .map_err(|error| format!("invalid identity API URL: {error}"))
}

fn estate_identity_url(app_state: &crate::app_state::AppState, path: &str) -> Result<Url, String> {
    identity_url_from_base(
        &crate::relay::relay_api_base_url_with_override(app_state),
        path,
    )
}

/// The origin the challenge will be minted for: scheme + host (+ port), no path.
///
/// The estate's challenge mints `origin` into the signed binding event and requires
/// https with no path or query (vgate/internal/buzzid/challenge.go ValidateOrigin),
/// which is what makes the user's consent page provably the same origin the app is
/// talking to. It replaces the constant `BUILDERLAB_ORIGIN` on this path.
fn estate_identity_origin(base: &str) -> Result<String, String> {
    let url = identity_url_from_base(base, "/")?;
    if url.host_str().is_none() {
        return Err("identity API URL has no host".to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

/// POST a JSON body to the estate identity API, authenticated with NIP-98.
///
/// Signing uses `AppState::signing_keys()`, NOT `state.keys`: that accessor is the
/// one place that refuses to sign while the identity is lost or the keyring is locked
/// (app_state_accessors.rs:52), and an identity request is exactly the kind of request
/// that must not be signed with a key that is not really the user's.
async fn nip98_identity_json(
    app_state: &crate::app_state::AppState,
    method: reqwest::Method,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = estate_identity_url(app_state, path)?;
    let body_bytes = serde_json::to_vec(&body)
        .map_err(|error| format!("invalid identity request body: {error}"))?;
    let auth = {
        let keys = app_state.signing_keys()?;
        crate::relay::build_nip98_auth_header_for_keys(&keys, &method, url.as_str(), &body_bytes)?
    };
    let response = app_state
        .http_client
        .request(method, url)
        .header(reqwest::header::AUTHORIZATION, auth)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body_bytes)
        .timeout(Duration::from_secs(IDENTITY_REQUEST_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|error| format!("identity request failed: {error}"))?;
    let status = response.status();
    let mut value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("invalid identity response: {error}"))?;
    if !status.is_success() {
        // The estate answers the frozen vgate envelope `{error: "<code>", message, detail}`
        // (vgate/internal/apierr) — note `error` is a STRING. Every caller of these
        // commands reads `error.code` (hostedCommunityApi.ts:20-24 and the
        // `hostedCommunityErrorMessage` lookup at :80-88), so the flat envelope is
        // translated into the nested shape the UI already understands before it is
        // returned. Without this the app would throw away a `restricted: …` refusal and
        // show the generic fallback sentence — a refusal the user cannot act on.
        if value.get("error").is_some() {
            normalize_identity_error(&mut value);
            return Ok(value);
        }
        return Err(format!("identity request failed (HTTP {status})."));
    }
    Ok(value)
}

/// Re-shape the estate's flat error envelope into the nested one this app's UI reads.
///
/// `{"error":"<code>","message":"…","detail":{…}}` → `{"error":{"code":…,"message":…,"detail":…}}`.
/// A value whose `error` is not a string is left EXACTLY as it arrived: this function
/// translates one known shape and never guesses at another, so a future server shape
/// surfaces as itself rather than as a mangled one.
///
/// Why translate in Rust instead of teaching the frontend: the extension points are the
/// contrast. Here it is one function in the one helper every identity call already uses,
/// and the still-vendor `communities/*` path — which genuinely does return the nested
/// shape — is untouched. In the frontend it would be ~20 `.error` use sites across
/// `hostedCommunityApi.ts` and `HostedCommunitiesSettingsCard.tsx`, including a working
/// vendor path, to fix a shape only the estate emits.
fn normalize_identity_error(value: &mut serde_json::Value) {
    let Some(code) = value
        .get("error")
        .and_then(|error| error.as_str())
        .map(str::to_owned)
    else {
        return;
    };
    let message = value
        .get("message")
        .and_then(|message| message.as_str())
        .map(str::to_owned);
    let detail = value.get("detail").cloned();

    let mut nested = serde_json::Map::new();
    nested.insert("code".to_owned(), serde_json::Value::String(code));
    if let Some(message) = message {
        nested.insert("message".to_owned(), serde_json::Value::String(message));
    }
    if let Some(detail) = detail {
        nested.insert("detail".to_owned(), detail);
    }
    value["error"] = serde_json::Value::Object(nested);
}

/// Wall-clock bound for one identity request. Shorter than the vendor's 60s: the
/// estate is one hop away inside our own edge, and an identity call that hangs is a
/// signed-out user staring at a spinner.
const IDENTITY_REQUEST_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Deserialize)]
struct NostrIdentityChallenge {
    challenge_id: String,
    nonce: String,
    verification_code: String,
    origin: String,
    expires_at: String,
}

async fn authenticated_json(
    client: &reqwest::Client,
    session: &BuilderlabSession,
    method: reqwest::Method,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let credential = session
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(|stored| stored.credential.clone())
        .ok_or_else(|| "Sign in to Builderlab first".to_owned())?;
    let response = client
        .request(method, api_url(path)?)
        .header(BB_SESSION_CREDENTIAL_HEADER, credential)
        .header(reqwest::header::ORIGIN, BUILDERLAB_ORIGIN)
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|error| format!("Builderlab request failed: {error}"))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("invalid Builderlab response: {error}"))?;
    if !status.is_success() {
        // Builderlab error responses carry a structured `{ error: { code,
        // message, setup_needed, ... } }` body. Pass those through as `Ok` so the
        // frontend's typed handling and friendly per-code messages apply, instead
        // of surfacing a raw JSON blob. Only fall back to a plain string when the
        // body isn't the expected shape.
        if value.get("error").is_some() {
            return Ok(value);
        }
        return Err(format!("Builderlab request failed (HTTP {status})."));
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn get_builderlab_nostr_identity(
    app_state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<serde_json::Value, String> {
    nip98_identity_json(
        &app_state,
        reqwest::Method::POST,
        IDENTITY_CURRENT_PATH,
        serde_json::json!({}),
    )
    .await
}

#[tauri::command]
pub(crate) async fn bind_builderlab_nostr_identity(
    app_state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<serde_json::Value, String> {
    let base = crate::relay::relay_api_base_url_with_override(&app_state);
    let challenge_value = nip98_identity_json(
        &app_state,
        reqwest::Method::POST,
        IDENTITY_CHALLENGE_PATH,
        serde_json::json!({ "origin": estate_identity_origin(&base)? }),
    )
    .await?;
    // A structured error here (e.g. missing_mapping) arrives as an object with an
    // `error` field rather than a challenge — hand it straight back so the
    // frontend maps it to a friendly message instead of hitting a deserialize
    // failure below.
    if challenge_value.get("error").is_some() {
        return Ok(challenge_value);
    }
    let challenge: NostrIdentityChallenge = serde_json::from_value(challenge_value)
        .map_err(|error| format!("invalid Nostr identity challenge: {error}"))?;
    let keys = app_state.signing_keys()?;
    let event = crate::commands::build_nostr_identity_binding_event(
        &keys,
        &challenge.challenge_id,
        &challenge.nonce,
        &challenge.verification_code,
        &challenge.origin,
        &challenge.expires_at,
    )?;
    nip98_identity_json(
        &app_state,
        reqwest::Method::POST,
        IDENTITY_VERIFY_PATH,
        serde_json::json!({
            "challenge_id": challenge.challenge_id,
            "nonce": challenge.nonce,
            "signed_payload": nostr::JsonUtil::as_json(&event),
        }),
    )
    .await
}

/// Unbind the caller's identity. OWNER-CLASS: this is the operation ruling A says
/// must never be reachable with a vendor session credential, and it is NIP-98 only
/// from day one. There is no fallback parameter and no legacy branch.
#[tauri::command]
pub(crate) async fn delete_builderlab_nostr_identity(
    app_state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<serde_json::Value, String> {
    nip98_identity_json(
        &app_state,
        reqwest::Method::POST,
        IDENTITY_DELETE_PATH,
        serde_json::json!({}),
    )
    .await
}

#[tauri::command]
pub(crate) async fn list_builderlab_communities(
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<serde_json::Value, String> {
    authenticated_json(
        &app_state.http_client,
        &session,
        reqwest::Method::POST,
        "/v1/buzz/communities/list",
        serde_json::json!({}),
    )
    .await
}

#[tauri::command]
pub(crate) async fn check_builderlab_community_name(
    name: String,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<serde_json::Value, String> {
    authenticated_json(
        &app_state.http_client,
        &session,
        reqwest::Method::POST,
        "/v1/buzz/communities/availability",
        serde_json::json!({ "name": name }),
    )
    .await
}

#[tauri::command]
pub(crate) async fn create_builderlab_community(
    name: String,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<serde_json::Value, String> {
    authenticated_json(
        &app_state.http_client,
        &session,
        reqwest::Method::POST,
        "/v1/buzz/communities",
        serde_json::json!({ "name": name }),
    )
    .await
}

#[tauri::command]
pub(crate) async fn archive_builderlab_community(
    community_id: String,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<serde_json::Value, String> {
    authenticated_json(
        &app_state.http_client,
        &session,
        reqwest::Method::POST,
        "/v1/buzz/communities/archive",
        serde_json::json!({ "community_id": community_id }),
    )
    .await
}

#[tauri::command]
pub(crate) async fn unarchive_builderlab_community(
    community_id: String,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<serde_json::Value, String> {
    authenticated_json(
        &app_state.http_client,
        &session,
        reqwest::Method::POST,
        "/v1/buzz/communities/unarchive",
        serde_json::json!({ "community_id": community_id }),
    )
    .await
}

#[tauri::command]
pub(crate) async fn transfer_builderlab_community(
    community_id: String,
    transferee_npub: String,
    app_state: tauri::State<'_, crate::app_state::AppState>,
    session: tauri::State<'_, BuilderlabSession>,
) -> Result<serde_json::Value, String> {
    // The Builderlab transfer endpoint expects camelCase keys, unlike the
    // archive/unarchive endpoints which take `community_id`; mirror the web
    // client's payload exactly.
    authenticated_json(
        &app_state.http_client,
        &session,
        reqwest::Method::POST,
        "/v1/buzz/communities/transfer",
        serde_json::json!({
            "communityId": community_id,
            "transfereeNpub": transferee_npub,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    #[test]
    fn auth_complete_page_uses_buzz_brand() {
        for expected in [
            "<title>Buzz authentication complete</title>",
            "#d7d72e",
            "#231e1e",
            "#d7e7f6",
            "aria-label=\"Buzz\"",
            "return to Buzz",
        ] {
            assert!(
                AUTH_COMPLETE_HTML.contains(expected),
                "authentication complete page is missing {expected}"
            );
        }
    }

    #[test]
    fn api_paths_stay_on_builderlab_api_origin() {
        let login = api_url("/v1/auth/login").unwrap();
        assert_eq!(
            login.origin().ascii_serialization(),
            "https://app.builderlab.xyz"
        );
        assert_eq!(login.path(), "/api/goose/v1/auth/login");
    }

    #[test]
    fn login_defaults_to_auth0_login() {
        let login = login_url("http://127.0.0.1:1234/callback/nonce").unwrap();
        let query: HashMap<_, _> = login.query_pairs().into_owned().collect();

        assert_eq!(query.get("type").map(String::as_str), Some("cli"));
        assert_eq!(query.get("product").map(String::as_str), Some("buzz"));
        assert_eq!(
            query.get("returnTo").map(String::as_str),
            Some("http://127.0.0.1:1234/callback/nonce")
        );
        assert!(!query.contains_key("screen_hint"));
    }

    // ── ruling A: the identity credential class is NIP-98 ──────────────────────

    #[test]
    fn identity_paths_stay_on_the_estate_origin_never_the_vendor_host() {
        // The repoint as a property: whatever estate base is configured, the identity
        // family resolves on THAT base, and never on the retired vendor host.
        for base in [
            "https://agents.vclawhub.com",
            "https://agents.vclawhub.com/",
        ] {
            for path in [
                IDENTITY_CURRENT_PATH,
                IDENTITY_CHALLENGE_PATH,
                IDENTITY_VERIFY_PATH,
                IDENTITY_DELETE_PATH,
            ] {
                let url = identity_url_from_base(base, path).expect("identity url");
                assert_eq!(url.host_str(), Some("agents.vclawhub.com"), "base {base}");
                assert_eq!(url.path(), path);
                assert_ne!(url.host_str(), Some("app.builderlab.xyz"));
                assert_eq!(
                    url.origin().ascii_serialization(),
                    "https://agents.vclawhub.com"
                );
            }
        }
    }

    #[test]
    fn estate_identity_origin_is_scheme_and_host_with_no_path() {
        // The estate's challenge refuses an origin with a path or query
        // (vgate/internal/buzzid/challenge.go ValidateOrigin), so the origin the app
        // ASKS for must be path-free by construction rather than by luck.
        let url = identity_url_from_base("https://agents.vclawhub.com", "/").expect("origin url");
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://agents.vclawhub.com"
        );
        assert_eq!(url.path(), "/");
    }

    #[test]
    fn identity_requests_are_nip98_signed_and_never_carry_the_vendor_session_header() {
        // The credential class, checked against the BYTES on the wire: the header is
        // `Authorization: Nostr <base64(event)>`, the event is kind 27235, and its tags
        // bind this request (u/method/payload) — the same header builder POST /query and
        // POST /events use, which is what makes the app's identity credential the
        // estate's Schnorr credential rather than a vendor token.
        let keys = nostr::Keys::generate();
        let url = identity_url_from_base("https://agents.vclawhub.com", IDENTITY_CURRENT_PATH)
            .expect("identity url");
        let body = b"{}";
        let header = crate::relay::build_nip98_auth_header_for_keys(
            &keys,
            &reqwest::Method::POST,
            url.as_str(),
            body,
        )
        .expect("nip98 header");

        assert!(header.starts_with("Nostr "), "header was {header}");
        assert!(
            !header.contains(BB_SESSION_CREDENTIAL_HEADER),
            "an identity request must not carry the retired vendor session credential"
        );

        let raw = base64::engine::general_purpose::STANDARD
            .decode(header.trim_start_matches("Nostr ").trim())
            .expect("base64 event");
        let event: serde_json::Value = serde_json::from_slice(&raw).expect("event json");
        assert_eq!(event["kind"], 27235);
        assert_eq!(
            event["pubkey"].as_str(),
            Some(keys.public_key().to_hex().as_str())
        );

        let tags = event["tags"].as_array().expect("tags");
        let has = |name: &str, value: &str| {
            tags.iter().any(|tag| {
                tag.as_array()
                    .map(|pair| pair.len() == 2 && pair[0] == name && pair[1] == value)
                    .unwrap_or(false)
            })
        };
        assert!(
            has("u", url.as_str()),
            "u tag must bind the identity URL: {tags:?}"
        );
        assert!(has("method", "POST"));
        let payload = Sha256::digest(body);
        assert!(has("payload", &hex::encode(payload)));
    }

    #[test]
    fn estate_error_envelope_is_reshaped_into_the_shape_the_ui_reads() {
        // vgate answers `{error: "<code>", message, detail}`; the UI reads `error.code`.
        // Measured consequence of NOT reshaping: `hostedCommunityErrorMessage` finds no
        // `code` and no `message` on a string, and returns its generic fallback — a
        // `restricted:` refusal becomes "Could not load the connected Buzz identity."
        let mut value = serde_json::json!({
            "error": "auth_required",
            "message": "restricted: auth event expired (created_at outside freshness window)",
            "detail": { "pubkey": "ab" }
        });
        normalize_identity_error(&mut value);
        assert_eq!(value["error"]["code"], "auth_required");
        assert_eq!(
            value["error"]["message"],
            "restricted: auth event expired (created_at outside freshness window)"
        );
        assert_eq!(value["error"]["detail"]["pubkey"], "ab");
        assert!(
            value["error"].is_object(),
            "error must no longer be a bare string: {value}"
        );
    }

    #[test]
    fn a_non_flat_error_envelope_is_left_exactly_as_it_arrived() {
        // This function translates ONE known shape. It must not guess at another: an
        // already-nested body (the vendor's, or a future server's) and a body with no
        // `error` at all both pass through byte-identical.
        let nested = serde_json::json!({ "error": { "code": "taken" }, "correlation_id": "c1" });
        let mut value = nested.clone();
        normalize_identity_error(&mut value);
        assert_eq!(value, nested);

        let bare = serde_json::json!({ "message": "no error field here" });
        let mut value = bare.clone();
        normalize_identity_error(&mut value);
        assert_eq!(value, bare);
    }
}
