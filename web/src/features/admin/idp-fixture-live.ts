/**
 * STAGED DATA, fixture 1 of 2 — the MEASURED live cross-tab.
 *
 * The population counts are the measured state of the live database on
 * 2026-09-21 (`.prime/handoff/idp-build/j14/README.md` and `READ_MODEL.md` §2):
 * 130 auto-admitted, 99 approved, 5 partly approved, 1 refused, 46 never
 * answered, 0 unclassifiable = 281 rows, of which 105 carry a real user answer.
 * The per-client ROW COUNTS are measured too (LANE3_INTAKE D3); the split of a
 * client's rows across the five populations is staged, and the splits add up to
 * the measured global cross-tab so this capture cannot contradict itself.
 *
 * What is NOT measured, and is labelled as illustrative in the capture note:
 * client display names, opaque subjects, usernames and organizations.
 */

import type {
  IdpAuthEventRow,
  IdpAuthEventsResponse,
  IdpClientView,
  IdpClientsResponse,
  IdpConsentPopulations,
  IdpConsentRow,
  IdpConsentSummaryResponse,
  IdpHealthResponse,
  IdpSessionsResponse,
  IdpTableCount,
} from "./idp-types";
import {
  AUDIT_NOTICE,
  GLOBAL_SCOPE,
  WINDOW,
  consentPayload,
  consentRow,
  groupViews,
  statesOf,
} from "./idp-fixture-builders";

// ---------------------------------------------------------------------------
// Fixture 1 — the measured live cross-tab
// ---------------------------------------------------------------------------

const LIVE_POPULATIONS: IdpConsentPopulations = {
  auto_admitted: 130,
  approved: 99,
  partial: 5,
  refused: 1,
  pending: 46,
  inconsistent: 0,
};

/** MEASURED 2026-09-21: 281 rows total, 235 with a response timestamp. */
const LIVE_TOTALS = {
  in_scope: 281,
  responded: 235,
  pending: 46,
  answered: 105,
  subjects: 16,
  clients: 8,
};

/**
 * Per-client cross-tab. The per-client ROW COUNTS are measured (LANE3_INTAKE
 * D3: chatto 106, vclaw-app 58, nextcrm 47, vchat-dashboard 30, vchat-pi-web
 * 21, pop 12, oclaw-app 5, buzz-web 2, buzz-desktop 0, vchat-vgate 0); the
 * split of each row count across the five populations is staged. The splits sum
 * to the measured global cross-tab, so the fixture cannot contradict itself.
 */
const LIVE_BY_CLIENT: Array<
  { key: string; org: string } & IdpConsentPopulations
> = [
  {
    key: "chatto",
    org: "greenzone",
    auto_admitted: 53,
    approved: 32,
    partial: 3,
    refused: 1,
    pending: 17,
    inconsistent: 0,
  },
  {
    key: "vclaw-app",
    org: "",
    auto_admitted: 30,
    approved: 18,
    partial: 1,
    refused: 0,
    pending: 9,
    inconsistent: 0,
  },
  {
    key: "nextcrm",
    org: "greenzone",
    auto_admitted: 25,
    approved: 15,
    partial: 1,
    refused: 0,
    pending: 6,
    inconsistent: 0,
  },
  {
    key: "vchat-dashboard",
    org: "",
    auto_admitted: 12,
    approved: 13,
    partial: 0,
    refused: 0,
    pending: 5,
    inconsistent: 0,
  },
  {
    key: "vchat-pi-web",
    org: "",
    auto_admitted: 10,
    approved: 8,
    partial: 0,
    refused: 0,
    pending: 3,
    inconsistent: 0,
  },
  {
    key: "pop",
    org: "",
    auto_admitted: 0,
    approved: 9,
    partial: 0,
    refused: 0,
    pending: 3,
    inconsistent: 0,
  },
  {
    key: "oclaw-app",
    org: "",
    auto_admitted: 0,
    approved: 3,
    partial: 0,
    refused: 0,
    pending: 2,
    inconsistent: 0,
  },
  {
    key: "buzz-web",
    org: "",
    auto_admitted: 0,
    approved: 1,
    partial: 0,
    refused: 0,
    pending: 1,
    inconsistent: 0,
  },
];

const LIVE_BY_DAY: Array<{ key: string } & IdpConsentPopulations> = [
  {
    key: "2026-09-19",
    auto_admitted: 40,
    approved: 30,
    partial: 2,
    refused: 0,
    pending: 12,
    inconsistent: 0,
  },
  {
    key: "2026-09-20",
    auto_admitted: 45,
    approved: 34,
    partial: 1,
    refused: 1,
    pending: 16,
    inconsistent: 0,
  },
  {
    key: "2026-09-21",
    auto_admitted: 45,
    approved: 35,
    partial: 2,
    refused: 0,
    pending: 18,
    inconsistent: 0,
  },
];

const LIVE_ROWS: IdpConsentRow[] = [
  consentRow({
    id: 281,
    client_id: "chatto",
    org: "greenzone",
    state: "auto_admitted",
    requested_at: "2026-09-21T14:40:26Z",
    responded_at: "2026-09-21T14:40:26Z",
  }),
  consentRow({
    id: 280,
    client_id: "buzz-web",
    state: "approved",
    requested_at: "2026-09-21T14:40:26Z",
    responded_at: "2026-09-21T14:40:31Z",
  }),
  consentRow({
    id: 279,
    client_id: "nextcrm",
    org: "greenzone",
    subject: "9f8e7d6c5b4a",
    username: "orhan",
    state: "partial",
    requested_at: "2026-09-21T11:02:07Z",
    responded_at: "2026-09-21T11:02:44Z",
    requested_scopes: ["openid", "profile", "email", "offline_access"],
    granted_scopes: ["openid", "profile", "email"],
  }),
  consentRow({
    id: 278,
    client_id: "pop",
    subject: "112233445566",
    username: "",
    username_resolved: false,
    state: "refused",
    requested_at: "2026-09-20T19:31:02Z",
    responded_at: "2026-09-20T19:31:19Z",
    requested_scopes: ["openid", "profile"],
    granted_scopes: [],
  }),
  consentRow({
    id: 277,
    client_id: "vclaw-app",
    state: "pending",
    requested_at: "2026-09-20T18:12:55Z",
    // NULL: the screen was shown and never answered. `records.go` measured two
    // rows whose requested_scopes are NULL too — this is one of them.
    requested_scopes: [],
    granted_scopes: [],
  }),
  consentRow({
    id: 276,
    client_id: "oclaw-app",
    subject: "778899aabbcc",
    state: "approved",
    requested_at: "2026-09-19T09:14:00Z",
    responded_at: "2026-09-19T09:14:08Z",
  }),
  consentRow({
    id: 275,
    client_id: "vchat-dashboard",
    state: "pending",
    requested_at: "2026-09-19T08:00:11Z",
    preconfigured: true,
    preconfiguration_id: 0,
  }),
];

const LIVE_CLIENTS: IdpClientView[] = [
  {
    client_id: "buzz-web",
    client_name: "Buzz web",
    public: true,
    pkce: {
      required: true,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email", "offline_access", "groups"],
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uri_hosts: ["agents.vclawhub.com"],
    token_endpoint_auth_method: "none",
    has_client_secret: false,
    org: "",
    owned: false,
  },
  {
    client_id: "buzz-desktop",
    client_name: "Buzz desktop",
    public: true,
    pkce: {
      required: true,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email", "offline_access"],
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uri_hosts: ["127.0.0.1:4711", "localhost:4711"],
    token_endpoint_auth_method: "none",
    has_client_secret: false,
    org: "",
    owned: false,
  },
  {
    client_id: "vclaw-app",
    client_name: "vclaw app",
    public: true,
    pkce: {
      required: true,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "implicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email", "offline_access"],
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uri_hosts: ["vclaw.app", "127.0.0.1:8090"],
    token_endpoint_auth_method: "none",
    has_client_secret: false,
    org: "",
    owned: false,
  },
  {
    client_id: "nextcrm",
    client_name: "NextCRM",
    public: false,
    pkce: {
      required: false,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email", "groups"],
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uri_hosts: ["crm.greenzone.example"],
    token_endpoint_auth_method: "client_secret_basic",
    has_client_secret: true,
    org: "greenzone",
    owned: true,
  },
  {
    client_id: "chatto",
    client_name: "Chatto",
    public: false,
    pkce: {
      required: false,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "implicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email", "groups"],
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uri_hosts: ["agents.vclawhub.com"],
    token_endpoint_auth_method: "client_secret_basic",
    has_client_secret: true,
    org: "greenzone",
    owned: true,
  },
  {
    client_id: "pop",
    client_name: "Pop",
    public: true,
    pkce: {
      required: true,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email"],
    grant_types: ["authorization_code"],
    redirect_uri_hosts: ["pop.vchat.email"],
    token_endpoint_auth_method: "none",
    has_client_secret: false,
    org: "",
    owned: false,
  },
  {
    client_id: "vchat-dashboard",
    client_name: "vchat dashboard",
    public: true,
    pkce: {
      required: true,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email"],
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uri_hosts: ["agents.vchat.email"],
    token_endpoint_auth_method: "none",
    has_client_secret: false,
    org: "",
    owned: false,
  },
  {
    client_id: "vchat-pi-web",
    client_name: "vchat pi web",
    public: true,
    pkce: {
      required: true,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile", "email"],
    grant_types: ["authorization_code"],
    redirect_uri_hosts: ["pi.vchat.email"],
    token_endpoint_auth_method: "none",
    has_client_secret: false,
    org: "",
    owned: false,
  },
  {
    client_id: "vchat-vgate",
    client_name: "vchat vgate",
    public: false,
    pkce: {
      required: false,
      declared: false,
      source: "provider_default_public_clients_only",
      note: "the client projection does not carry require_pkce; the effective answer is the provider default (public_clients_only)",
    },
    consent_mode: "explicit",
    authorization_policy: "one_factor",
    scopes: ["openid", "profile"],
    grant_types: ["client_credentials"],
    redirect_uri_hosts: [],
    token_endpoint_auth_method: "client_secret_post",
    has_client_secret: true,
    org: "",
    owned: false,
  },
];

/** MEASURED 2026-09-21: 346 logins, 260 ok, 85 failed, 1 banned, 122 OIDC callbacks. */
const LIVE_AUTH_TOTALS = {
  in_scope: 346,
  ok: 260,
  failed: 85,
  banned: 1,
  username_resolved: 101,
  username_unresolved: 245,
  with_oidc_uri: 122,
  client_id_parsed: 122,
  client_id_unparsed: 0,
  usernames: 44,
  remote_ips: 37,
};

const LIVE_AUTH_ROWS: IdpAuthEventRow[] = [
  {
    id: 346,
    time: "2026-09-21T14:40:31Z",
    outcome: "ok",
    successful: true,
    banned: false,
    username: "chance@vchat.email",
    username_resolved: false,
    auth_type: "OIDC",
    remote_ip: "84.113.9.17",
    client_id: "buzz-web",
    org: "",
    request_path: "/api/oidc/callback",
    request_method: "GET",
  },
  {
    id: 345,
    time: "2026-09-21T11:02:44Z",
    outcome: "ok",
    successful: true,
    banned: false,
    username: "orhan@vchat.email",
    username_resolved: false,
    auth_type: "OIDC",
    remote_ip: "88.230.4.61",
    client_id: "nextcrm",
    org: "greenzone",
    request_path: "/api/oidc/callback",
    request_method: "GET",
  },
  {
    id: 344,
    time: "2026-09-21T09:58:12Z",
    outcome: "failed",
    successful: false,
    banned: false,
    username: "chance",
    username_resolved: true,
    resolved_uid: "chance",
    auth_type: "PasswordAuthentication",
    remote_ip: "84.113.9.17",
    client_id: "",
    org: "",
    request_path: "/api/firstfactor",
    request_method: "POST",
  },
  {
    id: 343,
    time: "2026-09-20T22:07:49Z",
    outcome: "banned",
    successful: false,
    banned: true,
    username: "unknown@vchat.email",
    username_resolved: false,
    auth_type: "PasswordAuthentication",
    remote_ip: "45.155.205.233",
    client_id: "",
    org: "",
    request_path: "/api/firstfactor",
    request_method: "POST",
  },
  {
    id: 342,
    time: "2026-09-20T18:12:55Z",
    outcome: "ok",
    successful: true,
    banned: false,
    username: "chance@vchat.email",
    username_resolved: false,
    auth_type: "OIDC",
    remote_ip: "84.113.9.17",
    client_id: "vclaw-app",
    org: "",
    request_path: "/api/oidc/callback",
    request_method: "GET",
  },
];

/** The named counts `/health` reports. MEASURED 2026-09-21, read live. */
const LIVE_ASSERTIONS: IdpTableCount[] = [
  {
    name: "migrations_max_id",
    value: 15,
    query: "select coalesce(max(id), 0) from migrations",
    note: "the migration id the schema guard asserts (15 today; master is V0017)",
  },
  {
    name: "schema_tables",
    value: 21,
    query:
      "select count(*) from information_schema.tables where table_schema = 'public'",
    note: "tables in schema public (21 today)",
  },
  {
    name: "consent_total",
    value: 281,
    query: "select count(*) from oauth2_consent_session",
    note: "every row of the grant log, including the ones nobody answered",
  },
  {
    name: "consent_responded",
    value: 235,
    query:
      "select count(*) from oauth2_consent_session where responded_at is not null",
    note: "rows that produced a response timestamp",
  },
  {
    name: "consent_pending",
    value: 46,
    query:
      "select count(*) from oauth2_consent_session where responded_at is null",
    note: "NEVER ANSWERED — not refused",
  },
  {
    name: "consent_auto_admitted",
    value: 130,
    query:
      "select count(*) from oauth2_consent_session where responded_at is not null and authorized = false and granted = true",
    note: "admitted by implicit consent mode with no user interaction",
  },
  {
    name: "consent_approved",
    value: 99,
    query:
      "select count(*) from oauth2_consent_session where responded_at is not null and authorized = true and granted = true",
    note: "the user answered and granted everything",
  },
  {
    name: "consent_partial",
    value: 5,
    query:
      "select count(*) from oauth2_consent_session where responded_at is not null and authorized = true and granted = false",
    note: "the user answered and unchecked scopes",
  },
  {
    name: "consent_refused",
    value: 1,
    query:
      "select count(*) from oauth2_consent_session where responded_at is not null and authorized = false and granted = false",
    note: "the user answered and granted nothing",
  },
  {
    name: "consent_inconsistent",
    value: 0,
    query:
      "select count(*) from oauth2_consent_session where responded_at is null and (authorized = true or granted = true)",
    note: "unclassifiable rows: a decision with no response. MUST be 0",
  },
  {
    name: "consent_subjects_distinct",
    value: 16,
    query: "select count(distinct subject) from oauth2_consent_session",
    note: "distinct opaque subjects",
  },
  {
    name: "consent_clients_distinct",
    value: 8,
    query: "select count(distinct client_id) from oauth2_consent_session",
    note: "distinct client ids present in the grant log",
  },
  {
    name: "auth_total",
    value: 346,
    query: "select count(*) from authentication_logs",
    note: "every login attempt",
  },
  {
    name: "auth_ok",
    value: 260,
    query:
      "select count(*) from authentication_logs where successful = true and banned = false",
    note: "successful logins",
  },
  {
    name: "auth_failed",
    value: 85,
    query:
      "select count(*) from authentication_logs where successful = false and banned = false",
    note: "failed logins; the REASON is a journal line and is not in this database",
  },
  {
    name: "auth_banned",
    value: 1,
    query: "select count(*) from authentication_logs where banned = true",
    note: "banned attempts",
  },
  {
    name: "blacklisted_jti",
    value: 0,
    query: "select count(*) from oauth2_blacklisted_jti",
    note: "revoked tokens. 0 today: revocation has NEVER been exercised — the honest headline of any 'is revocation working' panel",
  },
  {
    name: "consent_preconfiguration",
    value: 0,
    query: "select count(*) from oauth2_consent_preconfiguration",
    note: "rows answering 'may this user SKIP the consent screen'. This is NOT consent and is never added to a consent population",
  },
  {
    name: "auth_username_unresolved",
    value: 245,
    query:
      "select count(*) from authentication_logs a left join user_opaque_identifier u on u.username = a.username where u.username is null",
    note: "audit rows whose login name is an address (or unknown): resolution needs the directory, layer 2",
  },
];

const LIVE_INVARIANTS: IdpHealthResponse["invariants"] = [
  {
    id: "schema_guard_verified",
    statement:
      "the live schema is migration 15 with exactly the expected column set of every table this service reads, verified before any read",
    ok: true,
    detail: "migration 15, 21 tables, 10 tables checked for exact column sets",
  },
  {
    id: "connection_is_read_only",
    statement:
      "every pooled connection reports default_transaction_read_only = on",
    ok: true,
    detail: "current_setting('default_transaction_read_only') = true",
  },
  {
    id: "pending_plus_responded_equals_total",
    statement:
      "consent: rows never answered + rows with a response timestamp = every row",
    ok: true,
    detail: "46 pending + 235 responded = 281, total = 281",
  },
  {
    id: "five_populations_partition_the_rows",
    statement:
      "the five populations and the defect bucket together account for every row, and the defect bucket is empty",
    ok: true,
    detail: "130 + 99 + 5 + 1 + 46 + 0 = 281",
  },
  {
    id: "answered_rows_match_the_response_timestamp",
    statement:
      "every responded row lands in exactly one of answered and auto-admitted",
    ok: true,
    detail: "105 answered + 130 auto-admitted = 235 responded",
  },
  {
    id: "every_row_classified_exactly_once",
    statement:
      "classifying every row in Go reproduces the SQL cross-tab exactly, with scanned == total",
    ok: true,
    detail: "scanned 281 rows, identical to the FILTER cross-tab",
  },
  {
    id: "every_consent_subject_resolves_to_a_username",
    statement:
      "every distinct subject joins user_opaque_identifier on (identifier, sector_id = '')",
    ok: true,
    detail: "16 of 16 subjects resolve",
  },
  {
    id: "subject_map_is_a_function",
    statement:
      "no duplicate username and no duplicate identifier in the subject map",
    ok: true,
    detail: "0 duplicates on either column",
  },
  {
    id: "auth_username_coverage_partitions",
    statement: "resolved + unresolved = total for the login audit's names",
    ok: true,
    detail: "101 resolved + 245 unresolved = 346",
  },
  {
    id: "auth_outcome_partitions",
    statement:
      "ok + failed + banned = total (a banned row is counted once, not also as failed)",
    ok: true,
    detail: "260 + 85 + 1 = 346",
  },
  {
    id: "oidc_audit_rows_are_attributable",
    statement:
      "every audit row whose request_uri contains oidc yields a client id",
    ok: true,
    detail: "122 of 122",
  },
  {
    id: "client_inventory_partitions",
    statement: "visible + out-of-scope = the projection size",
    ok: true,
    detail: "9 visible + 0 out of scope = 9",
  },
  {
    id: "idp_jwks_reachable",
    statement: "the live IdP serves a JWKS document with a key id",
    ok: true,
    detail:
      'url=http://127.0.0.1:9091/api/oidc/jwks kid="0ccf53-rs256" alg="RS256" keys=1',
  },
];

export const liveClientsPayload: IdpClientsResponse = {
  schema: "idp.clients.v1",
  as_of: "2026-09-21T16:35:00Z",
  source: {
    path: "/etc/authelia/clients.projection.yml",
    sha256: "3d1f0c8a5b6e4792ac13de56f0b7c4a91e2d8f3b6a0c5e7d9182ab34cd56ef70",
    projection_version: 1,
    generated_by: "render-clients.py",
    source_config_sha256:
      "56d1324a1d628d404823f455f938f4720b1c9e7a44d3f28f6b0e5a17cd93e214",
    source_config_bytes: 19517,
  },
  org_scope: GLOBAL_SCOPE,
  counts: {
    total: 9,
    visible: 9,
    out_of_scope: 0,
    owned: 2,
    visible_unowned: 7,
  },
  clients: LIVE_CLIENTS,
};

export const liveConsentPayload = consentPayload({
  populations: LIVE_POPULATIONS,
  totals: LIVE_TOTALS,
  rows: LIVE_ROWS,
});

export const liveConsentRefusedPayload = consentPayload({
  populations: LIVE_POPULATIONS,
  totals: LIVE_TOTALS,
  stateFilter: "refused",
  rows: LIVE_ROWS.filter((row) => row.state === "refused"),
});

export const liveSummaryPayload: IdpConsentSummaryResponse = {
  schema: "idp.consent.summary.v1",
  window: WINDOW,
  org_scope: GLOBAL_SCOPE,
  group_by: "both",
  populations: LIVE_POPULATIONS,
  states: statesOf(LIVE_POPULATIONS),
  totals: LIVE_TOTALS,
  out_of_scope: { rows: 0 },
  by_client: groupViews(LIVE_BY_CLIENT),
  by_day: groupViews(LIVE_BY_DAY),
  audit: AUDIT_NOTICE,
};

export const liveAuthPayload: IdpAuthEventsResponse = {
  schema: "idp.auth-events.v1",
  window: { ...WINDOW, basis: "authentication_logs.time (half-open)" },
  org_scope: GLOBAL_SCOPE,
  outcome_filter: "",
  totals: LIVE_AUTH_TOTALS,
  out_of_scope: { rows: 0 },
  page: {
    limit: 25,
    returned: LIVE_AUTH_ROWS.length,
    next_cursor: "342",
    truncated: true,
    order: "id descending (keyset)",
  },
  audit: AUDIT_NOTICE,
  denial_reason:
    "not available in this database: the cause of a denial is a journal line, not a column. Rows report the outcome only",
  rows: LIVE_AUTH_ROWS,
};

export const liveSessionsPayload: IdpSessionsResponse = {
  schema: "idp.sessions.v1",
  backend: "127.0.0.1:6379",
  dbsize: 23,
  prefixes: [{ prefix: "authelia-session:", count: 23 }],
  other: 0,
  scanned: 23,
  read_at: "2026-09-21T16:35:00Z",
  per_user_attribution:
    "NOT BUILT: attributing a session key to a human needs the key's payload, and the key IS the cookie value (design §3.6, §7 Q7). No per-user session lookup exists here",
  commands: ["DBSIZE", "SCAN <cursor> MATCH <prefix>* COUNT 200"],
  audit: AUDIT_NOTICE,
};

export const liveHealthPayload: IdpHealthResponse = {
  schema: "idp.health.v1",
  status: "ok",
  ok: true,
  as_of: "2026-09-21T16:35:00Z",
  read_only: true,
  schema_guard: {
    migration_id: 15,
    migration_rows: 15,
    migration_version_after: 15,
    application_version: "v4.38.0",
    tables: 21,
    default_transaction_read_only: true,
    checked_at: "2026-09-21T16:35:00Z",
    expected_migration_id: 15,
  },
  assertions: LIVE_ASSERTIONS,
  invariants: LIVE_INVARIANTS,
  jwks: {
    url: "http://127.0.0.1:9091/api/oidc/jwks",
    kid: "0ccf53-rs256",
    alg: "RS256",
    keys: 1,
    fetched_at: "2026-09-21T16:35:00Z",
  },
  clients: {
    source: "/etc/authelia/clients.projection.yml",
    sha256: "3d1f0c8a5b6e4792ac13de56f0b7c4a91e2d8f3b6a0c5e7d9182ab34cd56ef70",
    live_count: 9,
    visible_to_caller: 9,
    out_of_scope: 0,
    ownership_registry: "2 owned clients",
  },
  sessions: {
    backend: "127.0.0.1:6379",
    dbsize: 23,
    prefixes: [{ prefix: "authelia-session:", count: 23 }],
    other: 0,
    scanned: 23,
  },
  window: WINDOW,
  audit: AUDIT_NOTICE,
  notes: [
    "every number below is READ LIVE and carries the query it came from; nothing in this payload is a constant",
    "the populations are the classification of classify.go, checked against an independent SQL cross-tab (see the every_row_classified_exactly_once invariant)",
    "oauth2_consent_preconfiguration is NOT consent: it is counted and labelled, and is never merged into a consent population",
  ],
};
