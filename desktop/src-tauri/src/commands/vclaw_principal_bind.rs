//! The device binding: THIS DEVICE -> THE SIGNED-IN PRINCIPAL (job A1 of
//! `docs/AUTH_BIND_PLAN.md`).
//!
//! ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
//! The relay authorises by npub, so a signed-in app that has no npub row can reach
//! nothing: it mounts a shell whose every request the estate refuses, and the person sees an app
//! with no agents, no error and no next step. That is the defect the front-end gate
//! (`src/features/onboarding/ui/VclawBindNotice.tsx`, `lib/vclawBindCopy.ts`) exists to make
//! visible, and this module is the implementation BEHIND that gate. Without it every sign-in
//! stops at "We could not confirm this device's binding" — which is the honest report of a
//! missing command, and not a state to ship.
//!
//! ── WHY IT TAKES NO ARGUMENTS, AND HOLDS BOTH CREDENTIALS ITSELF ────────────
//! The bind needs TWO credentials: the caller's OIDC **id_token** (it names the principal — see step
//! 2 of the command, where sending the ACCESS token instead is shown to be a guaranteed refusal) and
//! a NIP-98 proof (it proves the key). Neither crosses the IPC boundary in either direction:
//!
//!   · The token stays where `vclaw_oidc.rs` keeps it — that module states the posture ("nothing in
//!     this module sends it anywhere but the IdP's own userinfo endpoint"), and a token in the
//!     webview is a token exposed to anything that can run script in a renderer that renders remote
//!     message content. The engine's id_token holder is memory-only for the same reason
//!     (`crates/buzz-agent/src/auth.rs:482`).
//!   · The NIP-98 proof is signed by the device key, which lives in the OS keyring and is already
//!     signed with natively (`relay.rs::build_nip98_auth_header`, reused here rather than
//!     reimplemented).
//!
//! So the front-end calls ONE semantic command with NO ARGUMENTS and receives an OUTCOME — never a
//! secret. `builderlab.rs` is the same shape for the same reason.
//!
//! ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
//! It does NOT decide that the binding already exists (it cannot read the estate's rows), it does
//! NOT retry, and it does NOT treat an unreadable answer as success. Idempotence is the ENDPOINT's
//! property; this reports it (`idempotent`).

use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use buzz_agent_pkg::auth::AuthIntent;

use crate::app_state::AppState;

use super::vclaw_oidc::vclaw_source;

/// The estate path of the self-service bind endpoint (job J1).
///
/// ⚠ IT LIVES UNDER `/api/` BY RULING (vclaw-lead, 2026-10-03), and that is a ROUTING decision, not
/// cosmetics: `/api/` is an ingress the estate's edge ALREADY serves (`/api/join-policy` answers 200
/// json through it), while the plan's original `/v1/principal/device/bind` reached the gateway only on
/// hosts that proxy `location /` — MEASURED on the live estate: the original path answered
/// `405 text/html` from nginx's static handler, i.e. it never arrived. A new endpoint must not need a
/// HOST CHANGE to be reachable.
///
/// The value is coordinated with J1's lane (its `api.DeviceBindPath` is the same string); it is one
/// constant so a change of mind is one line on each side.
const VCLAW_PRINCIPAL_BIND_PATH: &str = "/api/principal/device/bind";

/// The estate host this build binds against (the host the app's own estate community names).
///
/// ⚠ NOT the active workspace relay, and that is deliberate rather than an oversight. The bind
/// happens BEFORE the estate community exists — it is step 4 of 6 in `signInWithVclaw`, ahead of
/// `provisionVclawCommunity` on purpose (A1: bind before the first authorised request). Reading
/// `relay_api_base_url_with_override(state)` here would therefore resolve to the fallback relay
/// (`ws://localhost:3000` -> `http://localhost:3000`) and sign a NIP-98 `u` tag for the wrong URL —
/// which the estate refuses BY DESIGN, and would have looked like "the estate refused this device".
const VCLAW_PRINCIPAL_BASE_URL: &str = "https://agents.vclawhub.com";

/// Header carrying the OIDC token, beside the NIP-98 `Authorization`.
///
/// ⚠ THE TWO OBVIOUS NAMES ARE BOTH WRONG HERE, and that is why this one is new:
///   · `Authorization` is RESERVED for the NIP-98 event on every protected surface of this estate
///     (`buzz-gateway/internal/api/auth_nip98.go` splits it as `Nostr <event>` and refuses anything
///     else), so an OIDC `Bearer` token there would be judged a malformed NIP-98 credential.
///   · `Nostr-Federated-Identity` already MEANS something specific — a signed NIP-FI assertion, which
///     the gateway's verifier parses as a compact JWS and refuses with
///     "assertion field is not a Bearer credential" (`internal/nipfi/verifier.go`). Putting an OIDC
///     token in it would hand the estate a credential that reads as a broken assertion: the
///     wrong-layer failure this project keeps paying for.
///
/// CONFIRMED AGAINST J1's IMPLEMENTATION, not assumed: `buzz-gateway/internal/api/device_bind_http.go`
/// (`DeviceBindTokenHeader`) reads exactly this name and strips one optional, case-insensitive
/// `Bearer ` prefix. The plan's body field `id_token` is also accepted there; the header wins when
/// both are present, which is why this client sends the header and an empty body.
const VCLAW_PRINCIPAL_TOKEN_HEADER: &str = "X-Vclaw-Oidc-Token";

/// The request body — and it is EMPTY OF CLAIMS on purpose.
///
/// The token names the principal and the proof proves the key, so nothing here may name either: a
/// body that could carry a principal is a body that could claim a different one, which is one of
/// the refusals J1 must make. The payload hash still binds this body to the proof.
const VCLAW_PRINCIPAL_BIND_BODY: &[u8] = b"{}";

/// Per-request bound. The shared `http_client` sets no client-level timeout (it is also used for
/// long model downloads), so every bounded surface supplies its own — the same reason
/// `VCLAW_USERINFO_TIMEOUT` exists next door.
const VCLAW_PRINCIPAL_BIND_TIMEOUT: Duration = Duration::from_secs(15);

// ── The outcome vocabulary ──────────────────────────────────────────────────
//
// ⚠ THESE STRINGS ARE THE FRONT-END CONTRACT. `src/shared/api/vclawPrincipalBind.ts` maps them to
// the states the UI renders, and an unrecognised value there becomes `unreadable` — never a success.
// The test at the bottom of this file pins them against that list, so a rename here fails a test
// instead of silently re-opening the empty-app defect.
const OUTCOME_BOUND: &str = "bound";
const OUTCOME_ALREADY_BOUND: &str = "already_bound";
const OUTCOME_REFUSED: &str = "refused";
const OUTCOME_REVOKED: &str = "revoked";
const OUTCOME_IDP_UNREACHABLE: &str = "idp_unreachable";
const OUTCOME_SERVICE_UNREACHABLE: &str = "service_unreachable";
/// "I got an answer, but not an answer about THIS device." The front end reads it as the
/// `unreadable` state, which enters nothing and says so.
const OUTCOME_UNREADABLE: &str = "unreadable";

/// What the front end receives. Mirrors `VclawBindReport` in `src/shared/api/vclawPrincipalBind.ts`
/// FIELD FOR FIELD — a token is never part of it, and neither is any free text from the estate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VclawBindReport {
    /// One of the `OUTCOME_*` strings above.
    pub outcome: &'static str,
    /// The estate's refusal reason, as a short CODE, or `None`. Never prose: the front end renders
    /// it as an attribute for support and refuses to interpolate it into a sentence.
    pub reason: Option<String>,
    /// The HTTP status of the bind POST, when one arrived.
    pub status: Option<u16>,
    /// True when nothing was written because the row (and its device entry) already existed.
    pub idempotent: bool,
    /// The npub the row was written for, when the estate named one — 64 LOWERCASE hex, which is how
    /// the binding store is keyed, or `None`. A value that is not that is dropped rather than
    /// passed on: the front end treats a named-but-unreadable npub as a report it cannot act on.
    pub npub: Option<String>,
}

impl VclawBindReport {
    fn new(outcome: &'static str) -> Self {
        Self {
            outcome,
            reason: None,
            status: None,
            idempotent: false,
            npub: None,
        }
    }

    fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    fn with_reason(mut self, reason: Option<String>) -> Self {
        self.reason = reason;
        self
    }
}

/// The reason code the estate uses for a REVOKED device (job J3). Kept as a list because the
/// refusal vocabulary belongs to J1's lane and a single spelling would make every other spelling
/// read as an ordinary refusal — i.e. as the wrong next step (A4).
const REVOKED_REASON_CODES: [&str; 3] = ["device_revoked", "binding_revoked", "revoked"];

/// A reason code: short, lowercase, no whitespace. This is the SAME shape the front end admits, for
/// the same reason — a value that can carry a URL, a sentence or a credential is not a code.
fn is_reason_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The npub key: 64 LOWERCASE hex, exactly as the binding store is keyed. Anything else is `None`,
/// so a malformed value cannot travel as if it were the row's key.
fn read_npub(value: Option<&serde_json::Value>) -> Option<String> {
    let candidate = value?.as_str()?;
    if candidate.len() == 64
        && candidate
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        Some(candidate.to_owned())
    } else {
        None
    }
}

/// The estate's own refusal reason, if it sent one that really is a code.
///
/// `reason` FIRST, because that is the confirmed field of the adopted envelope
/// (`buzz-gateway/internal/api/device_bind_http.go`); `error` is kept for the estate's other writers,
/// which name it that way. `""` is not a code, so a success — which sends `reason: ""` — reads as
/// "no reason", exactly as intended.
fn read_reason(body: &serde_json::Value) -> Option<String> {
    for key in ["reason", "error", "code"] {
        if let Some(value) = body.get(key).and_then(serde_json::Value::as_str) {
            if is_reason_code(value) {
                return Some(value.to_owned());
            }
        }
    }
    None
}

/// The estate's own OUTCOME, when it sent one that is a word in the agreed vocabulary.
///
/// This is the estate's classification of its own answer, and it is strictly better informed than
/// anything this side can infer: it knows WHICH refusal it made (`binding_revoked` and
/// `binding_exists` are both 409, and they are different instructions to the person).
fn read_outcome(body: &serde_json::Value) -> Option<&'static str> {
    let value = body.get("outcome").and_then(serde_json::Value::as_str)?;
    [
        OUTCOME_BOUND,
        OUTCOME_ALREADY_BOUND,
        OUTCOME_REFUSED,
        OUTCOME_REVOKED,
        OUTCOME_IDP_UNREACHABLE,
        OUTCOME_SERVICE_UNREACHABLE,
        OUTCOME_UNREADABLE,
    ]
    .into_iter()
    .find(|candidate| *candidate == value)
}

/// Read the estate's answer.
///
/// ── THE TABLE, AND WHY EACH ROW IS THE ROW IT IS ────────────────────────────
/// * AN OUTCOME IN THE BODY WINS. The endpoint answers in this vocabulary on purpose (the two halves
///   of J1 share one enum), so when it speaks, this side quotes it rather than second-guessing it.
///   The one thing that is NOT taken on trust is a SUCCESS claim with a non-2xx status: that is a
///   contradiction, and it is reported as `unreadable` (see the test).
/// * NO READABLE OUTCOME -> the STATUS CLASS decides, which is what keeps this working against a
///   response that is not this endpoint at all (an nginx page, a proxy error):
///   - 2xx           -> `unreadable`, NEVER `bound`: a success claim this side cannot read is not a
///                      success, and guessing it is how the empty-app defect comes back.
///   - 404/405       -> the endpoint is not there (J1 unbuilt, or a host that serves something else
///                      on that path — MEASURED on the live edge: `405 text/html` from nginx's
///                      static handler). `unreadable` + `endpoint_absent`: the estate decided
///                      nothing about this device.
///   - 400/401/403/409/422 -> `refused` with the code when there is one. A decision about the
///                      credential or the request.
///   - >= 500        -> `service_unreachable`: nothing the caller sends can succeed until the
///                      service is fixed — the opposite instruction to "sign in again".
///
/// A transport failure never reaches this function; the caller reports it as `service_unreachable`.
fn classify_bind_response(status: u16, body: &serde_json::Value) -> VclawBindReport {
    let reason = read_reason(body);
    let npub = read_npub(body.get("npub"));
    let idempotent = body
        .get("idempotent")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    if let Some(outcome) = read_outcome(body) {
        let success_claim = outcome == OUTCOME_BOUND || outcome == OUTCOME_ALREADY_BOUND;
        if success_claim && !(200..300).contains(&status) {
            return VclawBindReport::new(OUTCOME_UNREADABLE)
                .with_status(status)
                .with_reason(Some("contradictory_status".to_owned()));
        }
        return VclawBindReport {
            outcome,
            reason,
            status: Some(status),
            // `already_bound` IS the statement that nothing was written, so it is idempotent
            // whether or not the flag agrees; the flag alone is never enough to say so.
            idempotent: idempotent || outcome == OUTCOME_ALREADY_BOUND,
            npub,
        };
    }

    if status == 404 || status == 405 {
        return VclawBindReport::new(OUTCOME_UNREADABLE)
            .with_status(status)
            .with_reason(Some(reason.unwrap_or_else(|| "endpoint_absent".to_owned())));
    }

    if status >= 500 {
        return VclawBindReport::new(OUTCOME_SERVICE_UNREACHABLE)
            .with_status(status)
            .with_reason(Some(reason.unwrap_or_else(|| "service_error".to_owned())));
    }

    if status >= 400 {
        // No outcome word, but a code that says the binding was REVOKED: still its own answer,
        // because "sign in again" and "try again" are different instructions (A4).
        let outcome = match reason.as_deref() {
            Some(code) if REVOKED_REASON_CODES.contains(&code) => OUTCOME_REVOKED,
            _ => OUTCOME_REFUSED,
        };
        return VclawBindReport::new(outcome)
            .with_status(status)
            .with_reason(reason);
    }

    // A 2xx with nothing this side can read. NOT a success.
    VclawBindReport::new(OUTCOME_UNREADABLE)
        .with_status(status)
        .with_reason(Some("unreadable_report".to_owned()))
}

/// Compose the bind URL from a base. Split out so a test can pin the PATH without touching the
/// environment (env vars are process-global and these tests run in parallel).
fn bind_url_from_base(base: &str) -> String {
    format!(
        "{}{}",
        base.trim_end_matches('/'),
        VCLAW_PRINCIPAL_BIND_PATH
    )
}

/// The estate base this build binds against.
///
/// Precedence matches `relay_api_base_url`: a runtime override, then a build-time one, then the
/// estate constant — so a dev/CI estate can be pointed at without rebuilding, and the shipped build
/// needs no environment at all.
fn principal_bind_base_url() -> String {
    crate::relay::configured_env_var("BUZZ_PRINCIPAL_BASE")
        .or_else(|| option_env!("BUZZ_DESKTOP_BUILD_PRINCIPAL_BASE").map(str::to_owned))
        .unwrap_or_else(|| VCLAW_PRINCIPAL_BASE_URL.to_owned())
}

fn principal_bind_url() -> String {
    bind_url_from_base(&principal_bind_base_url())
}

/// Bind THIS device to the signed-in principal.
///
/// Returns a report for every outcome that is a DECISION or a measurement, and `Err` only for a
/// failure this layer cannot describe — which is why the front end treats a rejection as the
/// `unreadable` state rather than as a class of its own.
#[tauri::command]
pub async fn vclaw_bind_principal_device(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<VclawBindReport, String> {
    // 1. A SESSION FIRST, SILENTLY. `Headless` never opens a browser; if there is no session at all
    //    the app is not signed in, which is a credential-class outcome rather than "the service is
    //    down".
    let source = vclaw_source(app)?;
    let access_token = match source.acquire_with_intent(AuthIntent::Headless, None).await {
        Ok(token) => token,
        Err(_) => {
            return Ok(VclawBindReport::new(OUTCOME_IDP_UNREACHABLE)
                .with_reason(Some("no_token".to_owned())))
        }
    };

    // 2. THE ID_TOKEN — NOT THE ACCESS TOKEN, and the difference is the whole credential.
    //
    //    MEASURED THREE WAYS, and this is not a preference:
    //      · this engine's OWN words: the access token it caches is OPAQUE and "this [id_token] is
    //        the ONLY credential that can carry a human identity to a control endpoint"
    //        (`crates/buzz-agent/src/auth.rs:464-482`);
    //      · the live IdP sets no access-token signing alg for this client (Authelia's default is
    //        `none`), so the access token is not a JWS;
    //      · the verifier behind the bind endpoint requires a three-part JWS and answers
    //        `token_invalid` otherwise — a GUARANTEED refusal that would read as an authorization
    //        problem.
    //
    //    `human_bearer()` is the accessor, and its `None` means "re-authenticate": the holder is
    //    MEMORY-ONLY by design (`auth.rs:482`), so a process that restarted with a still-valid cached
    //    session has no id_token even though it is signed in. The recovery below re-authenticates
    //    with the intent a human click deserves: passing the cached access token as `rejected` makes
    //    the engine REFRESH (the refresh path mints and stores a fresh id_token), and only a dead
    //    refresh grant escalates to a browser — which is then a genuine re-auth, not a surprise.
    let mut id_token = source.human_bearer().await;
    if id_token.is_none() {
        let _ = source
            .acquire_with_intent(AuthIntent::UserInitiated, Some(&access_token))
            .await;
        id_token = source.human_bearer().await;
    }
    let Some(id_token) = id_token else {
        return Ok(VclawBindReport::new(OUTCOME_IDP_UNREACHABLE)
            .with_reason(Some("no_id_token".to_owned())));
    };

    let url = principal_bind_url();

    // 3. THE PROOF. The estate's existing NIP-98 shape, signed by the device key (`u`, `method`,
    //    `payload`, `nonce`). A key that cannot sign (keyring locked) means the app has nothing to
    //    prove with: `unreadable`, never a success and never a refusal the estate did not make.
    let authorization = match crate::relay::build_nip98_auth_header(
        &reqwest::Method::POST,
        &url,
        VCLAW_PRINCIPAL_BIND_BODY,
        &state,
    ) {
        Ok(header) => header,
        Err(_) => {
            return Ok(VclawBindReport::new(OUTCOME_UNREADABLE)
                .with_reason(Some("no_signing_key".to_owned())))
        }
    };

    // 4. BOTH CREDENTIALS ON ONE REQUEST. `Authorization` carries the NIP-98 event; the token goes
    //    in its own field (see VCLAW_PRINCIPAL_TOKEN_HEADER). Nothing about either is logged here.
    let response = state
        .http_client
        .post(&url)
        .header("Authorization", authorization)
        .header(VCLAW_PRINCIPAL_TOKEN_HEADER, format!("Bearer {id_token}"))
        .header("Content-Type", "application/json")
        .timeout(VCLAW_PRINCIPAL_BIND_TIMEOUT)
        .body(VCLAW_PRINCIPAL_BIND_BODY.to_vec())
        .send()
        .await;

    // 5. THE ANSWER, CLASSIFIED. A transport failure is `service_unreachable`: the estate never made
    //    a decision about this device, and the person is told to retry rather than to sign in again.
    let response = match response {
        Ok(response) => response,
        Err(_) => {
            return Ok(VclawBindReport::new(OUTCOME_SERVICE_UNREACHABLE)
                .with_reason(Some("transport_error".to_owned())))
        }
    };
    let status = response.status().as_u16();
    // A body that is not JSON is read as "no fields", never as a reason to fail: the STATUS already
    // carries the decision, and the reason is optional by contract.
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    Ok(classify_bind_response(status, &body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// ⚠ THE FRONT-END CONTRACT, VERBATIM. Copied from `OUTCOME_STATES` in
    /// `src/shared/api/vclawPrincipalBind.ts`, which maps these strings to the states the UI renders,
    /// and identical to the enum `buzz-gateway/internal/api/device_bind_http.go` answers in. If this
    /// module ever emits something else, the front end reads it as `unreadable` — a safe failure, but
    /// a silent one, and this test is what makes it loud instead.
    const FRONTEND_READS: [&str; 7] = [
        "bound",
        "already_bound",
        "refused",
        "revoked",
        "idp_unreachable",
        "service_unreachable",
        "unreadable",
    ];

    fn emitted_outcomes() -> [&'static str; 7] {
        [
            OUTCOME_BOUND,
            OUTCOME_ALREADY_BOUND,
            OUTCOME_REFUSED,
            OUTCOME_REVOKED,
            OUTCOME_IDP_UNREACHABLE,
            OUTCOME_SERVICE_UNREACHABLE,
            OUTCOME_UNREADABLE,
        ]
    }

    #[test]
    fn every_outcome_this_module_emits_is_one_the_front_end_reads() {
        for outcome in emitted_outcomes() {
            assert!(
                FRONTEND_READS.contains(&outcome),
                "{outcome} is not in the front end's vocabulary (src/shared/api/vclawPrincipalBind.ts)"
            );
        }
    }

    #[test]
    fn the_report_json_names_are_the_ones_the_front_end_reads() {
        // A RENAME HERE IS A SILENT FAILURE WITHOUT THIS TEST: the front end reads `outcome`,
        // `reason`, `status`, `idempotent` and `npub` by name, and J1's lane writes exactly these
        // five in its own response struct (`buzz-gateway/internal/api/device_bind_http.go`).
        let report = VclawBindReport {
            outcome: OUTCOME_BOUND,
            reason: None,
            status: Some(200),
            idempotent: false,
            npub: Some("deadbeef".repeat(8)),
        };
        let value = serde_json::to_value(&report).expect("report serializes");
        let object = value.as_object().expect("report is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["idempotent", "npub", "outcome", "reason", "status"]);
        // AND NOTHING ELSE: no `detail`, no body echo, no place a credential could arrive.
        assert_eq!(object.len(), 5);
    }

    #[test]
    fn the_estates_own_outcome_is_quoted_rather_than_second_guessed() {
        let report = classify_bind_response(
            200,
            &json!({
                "outcome": "bound", "reason": "", "status": 200, "idempotent": false,
                "npub": "deadbeef".repeat(8),
            }),
        );
        assert_eq!(report.outcome, OUTCOME_BOUND);
        assert!(!report.idempotent);
        assert_eq!(report.status, Some(200));
        assert_eq!(report.npub, Some("deadbeef".repeat(8)));
        // The success envelope carries `reason: ""`, which is NOT a code and must read as "none".
        assert_eq!(report.reason, None);
    }

    #[test]
    fn an_idempotent_retry_is_already_bound_and_says_it_wrote_nothing() {
        let report = classify_bind_response(
            200,
            &json!({
                "outcome": "already_bound", "reason": "", "status": 200, "idempotent": true,
                "npub": "deadbeef".repeat(8),
            }),
        );
        assert_eq!(report.outcome, OUTCOME_ALREADY_BOUND);
        assert!(report.idempotent);

        // NEGATIVE CONTROL: `already_bound` IS the statement that nothing was written, so it is
        // idempotent even if the flag is missing — and a plain `bound` is NOT idempotent just because
        // a client assumed so.
        let no_flag = classify_bind_response(200, &json!({ "outcome": "already_bound" }));
        assert!(no_flag.idempotent);
        let fresh = classify_bind_response(200, &json!({ "outcome": "bound" }));
        assert!(!fresh.idempotent);
    }

    #[test]
    fn the_two_409s_are_told_apart_by_the_outcome_and_not_by_the_status() {
        // THE REASON THIS CLASSIFIER READS THE BODY. `binding_revoked` and `binding_exists` are BOTH
        // 409 and they are different instructions to the person ("sign in again" vs "not bound").
        // Status alone cannot split them; the estate's own outcome can.
        let revoked = classify_bind_response(
            409,
            &json!({ "outcome": "revoked", "reason": "binding_revoked", "status": 409 }),
        );
        assert_eq!(revoked.outcome, OUTCOME_REVOKED);
        assert_eq!(revoked.reason.as_deref(), Some("binding_revoked"));

        let refused = classify_bind_response(
            409,
            &json!({ "outcome": "refused", "reason": "binding_exists", "status": 409 }),
        );
        assert_eq!(refused.outcome, OUTCOME_REFUSED);
        assert_ne!(refused.outcome, revoked.outcome);
    }

    #[test]
    fn a_success_claim_beside_a_failure_status_is_a_contradiction() {
        // NEGATIVE CONTROL for the whole "quote the estate" branch: whatever the body says, a success
        // claim with a non-2xx status is not a success. Without this the app could enter the shell on
        // a report that proves nothing — the empty-app defect, rebuilt.
        for status in [400u16, 401, 409, 500, 503] {
            let report =
                classify_bind_response(status, &json!({ "outcome": "bound", "status": status }));
            assert_eq!(report.outcome, OUTCOME_UNREADABLE, "status {status}");
            assert_eq!(report.reason.as_deref(), Some("contradictory_status"));
        }
    }

    #[test]
    fn a_refusal_carries_its_code_and_stays_a_refusal() {
        let report = classify_bind_response(
            401,
            &json!({ "outcome": "refused", "reason": "token_invalid", "status": 401 }),
        );
        assert_eq!(report.outcome, OUTCOME_REFUSED);
        assert_eq!(report.status, Some(401));
        assert_eq!(report.reason.as_deref(), Some("token_invalid"));
        assert!(!report.idempotent);
        assert!(report.npub.is_none());
    }

    #[test]
    fn a_dead_endpoint_is_neither_a_refusal_nor_a_success() {
        // THE SHAPE THE LIVE EDGE SERVES TODAY — MEASURED: `POST
        // https://agents.vclawhub.com/v1/principal/device/bind` answers `405 text/html` from nginx's
        // static handler, so the body is not JSON and there is no outcome to read. The app must say
        // it could not confirm the binding.
        for status in [404u16, 405] {
            let report = classify_bind_response(status, &serde_json::Value::Null);
            assert_eq!(report.outcome, OUTCOME_UNREADABLE, "status {status}");
            assert_eq!(report.reason.as_deref(), Some("endpoint_absent"));
            assert_ne!(report.outcome, OUTCOME_BOUND);
            assert_ne!(report.outcome, OUTCOME_REFUSED);
        }
        // ...and when the request DOES reach J1 and the method is wrong, the estate names its own
        // reason and that is what travels.
        let reached = classify_bind_response(
            405,
            &json!({ "outcome": "unreadable", "reason": "method_not_allowed", "status": 405 }),
        );
        assert_eq!(reached.outcome, OUTCOME_UNREADABLE);
        assert_eq!(reached.reason.as_deref(), Some("method_not_allowed"));
    }

    #[test]
    fn a_dependency_failure_is_unreachable_not_a_credential_verdict() {
        let read = classify_bind_response(
            503,
            &json!({
                "outcome": "service_unreachable", "reason": "identity_verifier_unavailable",
                "status": 503,
            }),
        );
        assert_eq!(read.outcome, OUTCOME_SERVICE_UNREACHABLE);
        // NEGATIVE CONTROL: the dependency legs carry `*_unavailable` codes, and NONE of them may
        // read as a refusal — "an outage is never reported as a credential refusal" is the estate's
        // rule, and the person's next step is the opposite one.
        assert_ne!(read.outcome, OUTCOME_REFUSED);

        // No body at all, a 5xx: still `service_unreachable`, with this layer's own code.
        let bare = classify_bind_response(502, &serde_json::Value::Null);
        assert_eq!(bare.outcome, OUTCOME_SERVICE_UNREACHABLE);
        assert_eq!(bare.reason.as_deref(), Some("service_error"));

        // The transport case, which has no status at all.
        let transport = VclawBindReport::new(OUTCOME_SERVICE_UNREACHABLE)
            .with_reason(Some("transport_error".to_owned()));
        assert_eq!(transport.status, None);
    }

    #[test]
    fn a_2xx_this_side_cannot_read_is_not_a_success() {
        for body in [
            json!({}),
            json!({ "status": "bound" }),
            json!({ "outcome": "BOUND" }),
            json!({ "outcome": "ok" }),
        ] {
            let report = classify_bind_response(200, &body);
            assert_eq!(
                report.outcome, OUTCOME_UNREADABLE,
                "{body} must not read as a success"
            );
            assert_eq!(report.reason.as_deref(), Some("unreadable_report"));
        }
    }

    #[test]
    fn a_success_claim_never_carries_an_npub_the_store_could_not_be_keyed_by() {
        // `""` is the adopted envelope's "this refusal established no key", and it is read as ABSENT.
        // Anything else that is not 64 lowercase hex is dropped rather than passed on.
        for bad in [
            json!(""),
            json!("npub1qqqqq"),
            json!("DEADBEEF".repeat(8)),
            json!(42),
            json!(null),
        ] {
            let report = classify_bind_response(
                200,
                &json!({ "outcome": "bound", "npub": bad, "status": 200 }),
            );
            assert_eq!(report.outcome, OUTCOME_BOUND);
            assert!(report.npub.is_none(), "{bad} must not travel as a row key");
        }
    }

    #[test]
    fn a_reason_is_only_carried_when_it_really_is_a_code() {
        let kept = classify_bind_response(
            401,
            &json!({ "outcome": "refused", "reason": "proof_replayed", "status": 401 }),
        );
        assert_eq!(kept.reason.as_deref(), Some("proof_replayed"));
        // NEGATIVE CONTROL: the front end renders this value as an attribute, and refuses anything
        // that is not a code. A sentence, a URL or a bearer value must not survive this layer either.
        for bad in [
            "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
            "The proof was replayed: see https://estate.example/help",
            "PROOF_REPLAYED",
        ] {
            let report = classify_bind_response(
                401,
                &json!({ "outcome": "refused", "reason": bad, "status": 401 }),
            );
            assert_eq!(report.outcome, OUTCOME_REFUSED);
            assert!(report.reason.is_none(), "{bad} must not survive");
        }
    }

    #[test]
    fn the_wrappers_own_refusals_are_read_by_status_because_their_body_is_prose() {
        // J1's lane cannot give these legs a code: they come from the NIP-98 wrapper every lane
        // shares, whose body is `{"error": "restricted: <prose>"}`. The status class is the right
        // reading (401 -> refused) and the prose must NOT be carried as a reason code.
        for message in [
            "restricted: missing Authorization",
            "restricted: auth event replayed",
            "restricted: payload tag does not match body hash",
        ] {
            let report = classify_bind_response(401, &json!({ "error": message }));
            assert_eq!(report.outcome, OUTCOME_REFUSED);
            assert_eq!(report.status, Some(401));
            assert!(
                report.reason.is_none(),
                "{message} is prose, not a code, and must not reach a screen"
            );
        }
    }

    #[test]
    fn a_refusal_carrying_a_well_formed_npub_is_still_a_refusal() {
        // J1's lane states it plainly: on a refusal the `npub` may be the PROVEN key even though
        // nothing was written. The key is not a claim that a row exists — `outcome` and `idempotent`
        // are — so this must stay a refusal, with the key carried for support.
        let report = classify_bind_response(
            409,
            &json!({
                "outcome": "refused", "reason": "binding_exists",
                "status": 409, "npub": "deadbeef".repeat(8),
            }),
        );
        assert_eq!(report.outcome, OUTCOME_REFUSED);
        assert_eq!(report.npub, Some("deadbeef".repeat(8)));
        assert!(!report.idempotent);
        // NEGATIVE CONTROL: a well-formed npub on a refusal must not upgrade the verdict.
        assert_ne!(report.outcome, OUTCOME_BOUND);
        assert_ne!(report.outcome, OUTCOME_ALREADY_BOUND);
    }

    #[test]
    fn the_bind_url_is_the_estate_path_and_not_the_workspace_relay() {
        assert_eq!(
            bind_url_from_base("https://agents.vclawhub.com"),
            "https://agents.vclawhub.com/api/principal/device/bind"
        );
        // A trailing slash must not produce a double slash: the `u` tag is signed over this exact
        // string, and a URL that differs from the request is refused by design.
        assert_eq!(
            bind_url_from_base("https://agents.vclawhub.com/"),
            "https://agents.vclawhub.com/api/principal/device/bind"
        );
        // THE PATH IS UNDER THE INGRESS THE EDGE ALREADY SERVES, and it is the one J1 mounts
        // (`api.DeviceBindPath`). NEGATIVE CONTROL: the plan's original `/v1/...` path is the one
        // that answered `405 text/html` on the live estate — it needs a host change to be reachable,
        // and a test that let it back in would silently restore that gap.
        assert!(VCLAW_PRINCIPAL_BIND_PATH.starts_with("/api/"));
        assert!(!VCLAW_PRINCIPAL_BIND_PATH.starts_with("/v1/"));
    }

    #[test]
    fn the_token_header_is_the_one_j1_reads() {
        // ⚠ CROSS-LANE PIN. J1's lane reads this exact header name
        // (`api.DeviceBindTokenHeader`); a rename on either side is a `token_missing` refusal that
        // reads as a credential problem.
        assert_eq!(VCLAW_PRINCIPAL_TOKEN_HEADER, "X-Vclaw-Oidc-Token");
        assert_ne!(VCLAW_PRINCIPAL_TOKEN_HEADER, "Authorization");
        assert_ne!(VCLAW_PRINCIPAL_TOKEN_HEADER, "Nostr-Federated-Identity");
    }
}
