/**
 * The wire shapes of the phase-2 WRITE surface (design §3) and of the
 * `enforcement` object (§6.3).
 *
 * READ FROM THE CONTRACT, NOT INVENTED. Every field below is a JSON tag of a
 * struct in `buzz-gateway/internal/adminwrite/`:
 *
 *   http.go         the three envelopes (idp.client-change.v1, idp.apply.v1,
 *                   idp.changes.v1) and the error body
 *   enforcement.go  EnforcementState, DenyUntilTTLState
 *   plan.go         the client block the semantic diff is taken against
 *
 * The shapes phase 1 already fixes are IMPORTED, not restated: §3.4 serves
 * `org_scope`, `page` and `audit` with J14's own field names, so `../admin/idp-types.ts`
 * stays the one place those three are typed. A copy here would be a second
 * answer to "what is a page", which is exactly how the two surfaces drift.
 *
 * The tags that are easy to guess wrong, and are therefore called out here:
 *
 *  - `allows_are_enforcement` IS on the wire and this console DOES NOT READ IT to
 *    decide anything. `phase2-enforcement.ts` derives the same value from
 *    `available` and `mode` (design §6.3). It is the field that decides whether
 *    the word "allow" means anything, so it is the one field a renderer must not
 *    take on faith.
 *  - `deny_until_ttl.entries` is a number only when `deny_until_ttl.available` is
 *    true. The deny set IS administered through a route now (J20: `nipfi.Register`
 *    on the lane table, NIP-98-protected), but nothing a BROWSER can call reads a
 *    count from it (§6.2), and `entries: 0` would read as "nothing is revoked", a
 *    claim nobody made — so the field is typed as present-but-meaningless and the
 *    renderer must ignore it when unavailable.
 *  - `state` is a NINE-value vocabulary, and the wrapper's exit `0` is not one
 *    thing (§3.3). The applier parses the wrapper's `RESULT:` line and reports
 *    `applied_unverified` when it cannot classify one, so no renderer may
 *    collapse that into "applied".
 *  - `action` has no `delete` (§5.2): retirement is a state plus a residue
 *    report, and removing a client from the configuration stays a separate
 *    operator-approved change.
 *  - There is no field for a secret anywhere in this surface. `secrets.carried`
 *    is `false` by construction and `secret_fields.changed` carries NAMES only,
 *    so no component in this feature may render a masked placeholder such as
 *    "••••": there is nothing to mask.
 *  - `candidate.path` and `wrapper.argv` are PATHS on the server host, echoed for
 *    the operator's own record. They are display data, never input: nothing in
 *    this console may build a path from them.
 */

import type { IdpAccessAudit, IdpOrgScope, IdpPage } from "../admin/idp-types";

/**
 * The `schema` of each envelope (§3.1, §3.3, §3.4). They are constants, not
 * comments, because the readiness probe KEYS ON one of them: `200` plus
 * `schema: "idp.changes.v1"` is the only thing that makes the surface `ready`.
 */
export const PHASE2_SCHEMA = {
  change: "idp.client-change.v1",
  apply: "idp.apply.v1",
  changes: "idp.changes.v1",
} as const;

/** The change log's action vocabulary. There is no `delete`, on purpose (§5.2). */
export type Phase2ChangeAction = "create" | "patch" | "apply";

/**
 * The change `state` vocabulary, from two places that must not be merged: the
 * planner writes `planned` (§3.1), the applier maps the wrapper's exit code onto
 * the rest (§3.3), and §7.6 adds `rolled_back` for a change an operator undid.
 */
export type Phase2ChangeState =
  | "planned"
  | "applied"
  | "applied_unverified"
  | "refused_rotation_class"
  | "refused_validation"
  | "failed_write"
  | "failed_post_check"
  | "failed_timeout"
  | "rolled_back";

/** The same nine values as data, so a renderer can label an unknown one honestly. */
export const PHASE2_CHANGE_STATES: readonly Phase2ChangeState[] = [
  "planned",
  "applied",
  "applied_unverified",
  "refused_rotation_class",
  "refused_validation",
  "failed_write",
  "failed_post_check",
  "failed_timeout",
  "rolled_back",
];

/** The authority block: the ONE decision, quoted with the function that made it. */
export type Phase2Authority = {
  decided_by: string;
  scope: string;
  admin_orgs: string[];
  /** `authz.Decision.Why`, verbatim. A refusal reaches this console as `restricted: ` + it. */
  why: string;
};

/**
 * The maintenance window as `/changes` reports it (§3.4). Closed by default, and
 * no endpoint of this package can open one (§4.3): the row is written out of
 * band by an operator, so this object is READ-ONLY here and the console renders
 * it that way rather than offering an "open window" control that cannot exist.
 */
export type Phase2WindowState = {
  open: boolean;
  id: string;
  opened_by?: string;
  opened_at?: string;
  /** Absent/zero means no expiry — a window with no expiry is shown as stale, not as open forever. */
  expires_at?: string;
  reason?: string;
  opens_are_global_admin_only?: boolean;
  note?: string;
};

/** What the endpoint says about secrets — a statement, never a value. */
export type Phase2SecretsNote = {
  carried: boolean;
  note: string;
};

export type Phase2SemanticDiffField = {
  field: string;
  before: unknown;
  after: unknown;
  added?: string[];
  removed?: string[];
};

export type Phase2SecretFields = {
  /** Field NAMES. A value is never carried on this wire. */
  changed: string[];
  carried: boolean;
};

export type Phase2SemanticDiff = {
  client_id: string;
  fields: Phase2SemanticDiffField[];
  secret_fields: Phase2SecretFields;
};

/** The staged candidate the applier validated, as `/apply` reports it (§3.3). */
export type Phase2Candidate = {
  path?: string;
  sha256: string;
  bytes: number;
  outside_region_identical?: boolean;
  jwks_key_body_identical?: boolean;
  validator_output_identical?: boolean;
};

/**
 * The wrapper as `/apply` reports it. `exit_code` is NOT the verdict (§3.3): the
 * wrapper returns `0` for nothing-to-do, dry run and applied-and-verified alike,
 * so `result` — parsed from its `RESULT:` line — is the field that means
 * something, and `sha256_read_at_apply` is read at apply time rather than pinned
 * in code (a stale digest is how an unreviewed wrapper "proves" it was reviewed).
 */
export type Phase2Wrapper = {
  path?: string;
  sha256_read_at_apply?: string;
  argv?: string[];
  exit_code: number;
  result: string;
  backup_path?: string;
};

/** What the restart did, so an operator can see a restart that changed nothing. */
export type Phase2ServiceState = {
  restarted: boolean;
  active_enter_timestamp?: string;
  jwks_kid_before?: string;
  jwks_kid_after?: string;
  session_dbsize_before?: number;
  session_dbsize_after?: number;
};

/**
 * The rollback RECORD (§7). `command` is printed, never executed: a rollback is
 * a second fleet-wide restart, and it restores the previous bytes — which is why
 * rolling back across a JWKS rotation is forbidden (§7.2).
 */
export type Phase2Rollback = {
  command: string;
  restarts?: number;
  note?: string;
};

/** `201` from create, `200` from patch — one envelope (§3.1, §3.2). */
export type Phase2ClientChangeResponse = {
  schema: string;
  change_id: string;
  idempotent_replay: boolean;
  client_id: string;
  action: Phase2ChangeAction;
  state: Phase2ChangeState;
  org: string;
  authority: Phase2Authority;
  window: Phase2WindowState;
  reason: string;
  secrets: Phase2SecretsNote;
  /** Where the change goes next. Present on create; a plan is not an apply. */
  next?: string;
  /** Present on patch: non-secret fields only (§3.2). */
  semantic_diff?: Phase2SemanticDiff;
};

/** `200` from `/apply` (§3.3). Every refusal/failure body still carries `rollback`. */
export type Phase2ApplyResponse = {
  schema: string;
  change_id: string;
  idempotent_replay: boolean;
  client_id: string;
  state: Phase2ChangeState;
  window: Phase2WindowState;
  candidate?: Phase2Candidate;
  wrapper?: Phase2Wrapper;
  service?: Phase2ServiceState;
  rollback?: Phase2Rollback;
  reason?: string;
  /** Present when the applier could not classify the wrapper's `RESULT:` line. */
  honest?: string;
};

/** One row of the change log as `/changes` serves it (§3.4). */
export type Phase2ChangeRow = {
  change_id: string;
  at: string;
  actor: { principal: string; source: string };
  client_id: string;
  org: string;
  action: Phase2ChangeAction;
  state: Phase2ChangeState;
  reason: string;
  /** `sha256:` of the caller's key. The raw key is never stored and never logged (§4.1). */
  idempotency_key_fingerprint?: string;
  registry_sha256_before?: string;
  registry_sha256_after?: string;
  live_config_sha256_before?: string;
  live_config_sha256_after?: string;
  semantic_diff?: Phase2SemanticDiff;
  candidate?: Phase2Candidate;
  wrapper?: Phase2Wrapper;
  window?: Phase2WindowState;
  rollback?: Phase2Rollback;
};

/**
 * The change-log counts. `in_scope` and `out_of_scope` are both real numbers: a
 * row this caller may not read is COUNTED, not hidden (§3.4). Every key here is
 * a number the server reported, so none of them may be defaulted to `0` by a
 * renderer that did not receive it.
 */
export type Phase2Totals = {
  in_scope: number;
  out_of_scope: number;
  planned: number;
  applied: number;
  failed: number;
  refused: number;
};

/**
 * `GET /api/idp/changes` (§3.4). It reuses J14's `org_scope`, `page` and `audit`
 * shapes on purpose: the same reader must not see two different page objects.
 * The `window` object here is phase 2's own, because it answers "may I write",
 * not "how far back does this read go".
 */
export type Phase2ChangesResponse = {
  schema: string;
  as_of: string;
  org_scope: IdpOrgScope;
  page: IdpPage;
  totals: Phase2Totals;
  window: Phase2WindowState;
  enforcement: EnforcementState;
  audit: IdpAccessAudit;
  changes: Phase2ChangeRow[];
};

/**
 * The deny-until-TTL set as phase 2 can see it (§6.3).
 *
 * `available: false` is the state this console must render today: the deny set's
 * admin route exists and is NIP-98-protected, and a browser cannot sign that header,
 * so `entries` carries no information and `exposed_by` names the reason rather than a
 * route. It is typed as always-present because the Go struct has no `omitempty` on it:
 * the object exists, and its `available` flag is the only thing that says whether the
 * numbers in it mean anything.
 */
export type DenyUntilTTLState = {
  available: boolean;
  exposed_by: string;
  entries: number;
  note: string;
};

/**
 * The enforcement object of §6.3, field for field with the Go struct.
 *
 * `mode` is `"shadow" | "enforce" | ""`, and `""` means UNKNOWN — "an unknown
 * mode is not 'not shadow'" (§6.3). `enforcing` and `shadow` are the server's own
 * summaries of `mode`; this console derives what it renders from `available` and
 * `mode` so that a summary can never disagree with the banner.
 */
export type EnforcementState = {
  source: string;
  available: boolean;
  /** `"shadow" | "enforce" | ""` — the empty string is UNKNOWN. */
  mode: string;
  enforcing: boolean;
  shadow: boolean;
  would_deny_entries: number;
  allows_are_enforcement: boolean;
  deny_until_ttl: DenyUntilTTLState;
  note: string;
};
