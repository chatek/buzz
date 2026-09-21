/**
 * The wire shapes of `/api/idp/*` (phase 1, READ-ONLY).
 *
 * READ FROM THE GO SOURCE, NOT INVENTED. Every field below is a JSON tag of a
 * struct in `buzz-gateway/internal/admin/`:
 *
 *   http.go        the seven response envelopes and the error body
 *   clients.go     ClientView, PKCEView, Projection (`/clients`)
 *   classify.go    ConsentPopulations, StateCount, the five-way states
 *   records.go     ScopeDelta, TableCount, JoinCoverage
 *   schema.go      SchemaInfo      sessions.go  SessionSummary
 *   jwks.go        JWKSInfo        invariants.go Invariant
 *
 * The tags that are easy to guess wrong, and are therefore called out here:
 *
 *  - `/clients` returns `redirect_uri_hosts` (HOSTS only), never a URI list.
 *  - `has_client_secret` is a BOOLEAN. The payload carries no secret value at
 *    all, because the projection has no such field (design §5.1: secrets are
 *    omitted, not redacted). So no component in this feature may render a
 *    masked placeholder such as "••••" — there is nothing to mask.
 *  - `pkce` is THREE-valued: `declared` says whether the client block declared
 *    `require_pkce` at all, and `source` names where `required` came from. The
 *    J12 projection does not emit `require_pkce` today, so "required: true" is
 *    the provider default for a public client, and the note says so.
 *  - `totals` / `counts` / `out_of_scope` are Go `map[string]int`: the KEYS are
 *    part of the payload, not of this file. Read them by name, and treat a
 *    missing key as "the server did not report this number" — never as zero.
 *  - `responded_at` is `null` for a row the user never answered. It is the FIRST
 *    discriminator of the classification (`classify.go`), so it is typed
 *    nullable here on purpose and every renderer must handle null explicitly.
 */

export type IdpCountMap = Record<string, number>;

/** The error body: `{"error": "...", "detail": "..."}` (`http.go` fail/readErr). */
export type IdpErrorBody = {
  error?: string;
  detail?: string;
};

export type IdpOrgScope = {
  scope: string;
  global: boolean;
  admin_orgs: string[];
  orgs: string[];
  note: string;
};

/** Design §3.6: the view is itself audited; writing the row is phase 2. */
export type IdpAccessAudit = {
  sink: string;
  persisted: boolean;
  note: string;
};

export type IdpWindow = {
  since: string;
  until: string;
  default_days: number;
  basis: string;
  aged_out_of_window: number;
  note?: string;
};

export type IdpPage = {
  limit: number;
  returned: number;
  next_cursor: string;
  truncated: boolean;
  order: string;
};

export type IdpPkce = {
  required: boolean;
  declared: boolean;
  challenge_method?: string;
  source: string;
  note?: string;
};

export type IdpClientView = {
  client_id: string;
  client_name: string;
  public: boolean;
  pkce: IdpPkce;
  consent_mode: string;
  authorization_policy: string;
  scopes: string[];
  grant_types: string[];
  redirect_uri_hosts: string[];
  token_endpoint_auth_method: string;
  has_client_secret: boolean;
  org: string;
  owned: boolean;
};

export type IdpClientSourceInfo = {
  path: string;
  sha256: string;
  projection_version: number;
  generated_by: string;
  source_config_sha256: string;
  source_config_bytes: number;
};

export type IdpClientsResponse = {
  schema: string;
  as_of: string;
  source: IdpClientSourceInfo;
  org_scope: IdpOrgScope;
  counts: IdpCountMap;
  clients: IdpClientView[];
};

export type IdpClientResponse = {
  schema: string;
  as_of: string;
  client: IdpClientView;
  source: IdpClientSourceInfo;
};

/**
 * The five-way classification plus the defect bucket (`classify.go`). The order
 * is `LegalStates()`: the four a user's answer decided first, then the two that
 * are not answers. Nothing in this feature may collapse them.
 */
export type IdpConsentState =
  | "approved"
  | "partial"
  | "refused"
  | "auto_admitted"
  | "pending"
  | "inconsistent";

export type IdpConsentPopulations = {
  auto_admitted: number;
  approved: number;
  partial: number;
  refused: number;
  pending: number;
  inconsistent: number;
};

export type IdpStateCount = {
  state: string;
  label: string;
  count: number;
};

export type IdpScopeDelta = {
  missing: string[];
  extra: string[];
};

export type IdpConsentRow = {
  id: number;
  client_id: string;
  org: string;
  subject: string;
  username: string;
  username_resolved: boolean;
  state: string;
  state_label: string;
  authorized: boolean;
  granted: boolean;
  responded: boolean;
  requested_at: string;
  responded_at: string | null;
  requested_scopes: string[];
  granted_scopes: string[];
  scope_delta: IdpScopeDelta;
  preconfigured: boolean;
  preconfiguration_id?: number;
};

export type IdpConsentResponse = {
  schema: string;
  window: IdpWindow;
  org_scope: IdpOrgScope;
  state_filter: string;
  populations: IdpConsentPopulations;
  states: IdpStateCount[];
  totals: IdpCountMap;
  out_of_scope: IdpCountMap;
  page: IdpPage;
  audit: IdpAccessAudit;
  rows: IdpConsentRow[];
};

export type IdpGroupView = {
  key: string;
  org?: string;
  populations: IdpConsentPopulations;
  states: IdpStateCount[];
  totals: IdpCountMap;
};

export type IdpConsentSummaryResponse = {
  schema: string;
  window: IdpWindow;
  org_scope: IdpOrgScope;
  group_by: string;
  populations: IdpConsentPopulations;
  states: IdpStateCount[];
  totals: IdpCountMap;
  out_of_scope: IdpCountMap;
  by_client: IdpGroupView[];
  by_day: IdpGroupView[];
  audit: IdpAccessAudit;
};

export type IdpAuthEventRow = {
  id: number;
  time: string;
  outcome: string;
  successful: boolean;
  banned: boolean;
  username: string;
  username_resolved: boolean;
  resolved_uid?: string;
  auth_type: string;
  remote_ip: string;
  client_id: string;
  org: string;
  /** The URI's PATH only: the query string (`code_challenge`, `state`) is dropped in SQL. */
  request_path: string;
  request_method: string;
};

export type IdpAuthEventsResponse = {
  schema: string;
  window: IdpWindow;
  org_scope: IdpOrgScope;
  outcome_filter: string;
  totals: IdpCountMap;
  out_of_scope: IdpCountMap;
  page: IdpPage;
  audit: IdpAccessAudit;
  /** The server's own sentence about why no row carries a denial reason. */
  denial_reason: string;
  rows: IdpAuthEventRow[];
};

export type IdpSessionPrefix = {
  prefix: string;
  count: number;
};

export type IdpSessionsResponse = {
  schema: string;
  backend: string;
  dbsize: number;
  prefixes: IdpSessionPrefix[];
  other: number;
  scanned: number;
  read_at: string;
  /** "NOT BUILT: ..." — a sentence, not a number. Never render it as 0. */
  per_user_attribution: string;
  commands: string[];
  audit: IdpAccessAudit;
};

export type IdpSchemaGuard = {
  migration_id: number;
  migration_rows: number;
  migration_version_after: number;
  application_version: string;
  tables: number;
  default_transaction_read_only: boolean;
  checked_at: string;
  expected_migration_id: number;
};

export type IdpTableCount = {
  name: string;
  value: number;
  query: string;
  note?: string;
};

export type IdpInvariant = {
  id: string;
  statement: string;
  ok: boolean;
  detail: string;
  /** Checked-and-failed and could-not-check are different states. */
  unproven?: boolean;
};

export type IdpJwks = {
  url: string;
  kid: string;
  alg: string;
  keys: number;
  fetched_at: string;
  error?: string;
};

export type IdpHealthClients = {
  source?: string;
  sha256?: string;
  live_count?: number;
  visible_to_caller?: number;
  out_of_scope?: number;
  ownership_registry?: string;
};

export type IdpHealthSessions = {
  backend?: string;
  dbsize?: number;
  prefixes?: IdpSessionPrefix[];
  other?: number;
  scanned?: number;
  error?: string;
};

export type IdpHealthResponse = {
  schema: string;
  status: string;
  ok: boolean;
  as_of: string;
  read_only: boolean;
  schema_guard: IdpSchemaGuard;
  schema_guard_error?: string;
  assertions: IdpTableCount[];
  invariants: IdpInvariant[];
  jwks: IdpJwks;
  clients: IdpHealthClients;
  sessions: IdpHealthSessions;
  window: IdpWindow;
  audit: IdpAccessAudit;
  notes: string[];
};
