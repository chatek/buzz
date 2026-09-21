/**
 * STAGED DATA — the builders the two recorded captures are made with.
 *
 * The staged source exists so the five-way classification can be seen, checked and
 * screenshotted WITHOUT depending on the live surface. MEASURED 2026-09-22: the
 * route serves, and every `/api/idp/*` read is refused at admission with
 * `401 restricted: missing Authorization`, so a live read today returns no data at
 * all. Without a staged source the classification could not be exercised by
 * anybody — and a screen nobody can look at is a screen nobody has verified.
 *
 * THE RULES, which apply to both captures:
 *
 *  1. Nothing staged is presented as live. Each capture carries its own
 *     `captureNote`, and every panel renders it in a banner while a staged
 *     source is active (see `AdminConsolePage.tsx`). The source description
 *     begins with "STAGED DATA".
 *  2. The numbers are DERIVED, not typed twice: `consentPayload` builds the
 *     per-state array from the population object, so the population table and
 *     the per-state array cannot disagree.
 *  3. A SECOND capture carries DIFFERENT numbers on purpose. One test renders
 *     both and requires each to show its own numbers, which is how "nothing is
 *     transcribed into the render path" is checked rather than asserted.
 *  4. Client display names, opaque subjects, usernames and organizations are
 *     illustrative in both captures. The measured facts they hang off are
 *     named in the comments where they are used.
 *
 * These helpers are also where the SERVER'S OWN STATE LABELS live, copied
 * verbatim from `consentStateLabels` in
 * `buzz-gateway/internal/admin/classify.go`: a fixture that imitates the wire
 * must imitate its words too. The operator-facing headings are a separate
 * layer, in `consent-classification.ts`.
 */

import type {
  IdpConsentPopulations,
  IdpConsentResponse,
  IdpConsentRow,
  IdpConsentState,
  IdpGroupView,
  IdpStateCount,
} from "./idp-types";
import { CONSENT_STATE_ORDER } from "./consent-classification";

/**
 * The labels of record, copied VERBATIM from the server's
 * `consentStateLabels` map (`buzz-gateway/internal/admin/classify.go`). The
 * fixture imitates the wire, so it must imitate the words too; the operator-
 * facing headings live in `consent-classification.ts`.
 */
export const SERVER_STATE_LABELS: Record<IdpConsentState, string> = {
  approved:
    "approved — the user answered and every requested scope was granted",
  partial:
    "partially approved — the user answered and unchecked some requested scopes",
  refused: "refused — the user answered and granted nothing",
  auto_admitted: "auto-admitted — no user interaction (implicit consent mode)",
  pending:
    "never answered — the consent screen was shown and no response was recorded",
  inconsistent:
    "unclassifiable — the response timestamp contradicts the decision columns",
};

export function serverStateLabel(state: IdpConsentState): string {
  return SERVER_STATE_LABELS[state];
}

export function statesOf(populations: IdpConsentPopulations): IdpStateCount[] {
  return CONSENT_STATE_ORDER.map((state) => ({
    state,
    label: serverStateLabel(state),
    count: populations[state],
  }));
}

export function populationsOf(
  rows: Array<Partial<IdpConsentPopulations>>,
): IdpConsentPopulations {
  const total = (state: IdpConsentState) =>
    rows.reduce((sum, row) => sum + (row[state] ?? 0), 0);
  return {
    auto_admitted: total("auto_admitted"),
    approved: total("approved"),
    partial: total("partial"),
    refused: total("refused"),
    pending: total("pending"),
    inconsistent: total("inconsistent"),
  };
}

export const WINDOW = {
  since: "2026-06-23T00:00:00Z",
  until: "2026-09-21T16:35:00Z",
  default_days: 90,
  basis: "oauth2_consent_session.requested_at (half-open: >= since, < until)",
  aged_out_of_window: 0,
  note: "the window caps the VIEW; this feature deletes nothing (design §3.6)",
};

export const AUDIT_NOTICE = {
  sink: "log",
  persisted: false,
  note: "design §3.6 requires an access row per consent read; writing one is a WRITE and is Phase 2. This build logs the event (principal, orgs, filters, counts) and reports persisted=false",
};

export const GLOBAL_SCOPE = {
  scope: "global",
  global: true,
  admin_orgs: ["vchat.admin"],
  orgs: ["greenzone"],
  note: "an empty list is the correct answer for a caller in no org; it is not a 403 and not a partial view",
};

export function consentRow(
  init: Partial<IdpConsentRow> &
    Pick<IdpConsentRow, "id" | "client_id" | "state" | "requested_at">,
): IdpConsentRow {
  const state = init.state as IdpConsentState;
  const authorized =
    init.authorized ?? (state === "approved" || state === "partial");
  const granted =
    init.granted ??
    (state === "approved" ||
      state === "auto_admitted" ||
      state === "inconsistent");
  const requested = init.requested_scopes ?? [
    "openid",
    "profile",
    "email",
    "offline_access",
  ];
  const grantedScopes = init.granted_scopes ?? requested;
  const missing = requested.filter((s) => !grantedScopes.includes(s));
  const extra = grantedScopes.filter((s) => !requested.includes(s));
  return {
    id: init.id,
    client_id: init.client_id,
    org: init.org ?? "",
    subject: init.subject ?? "a1b2c3d4e5f6",
    username: init.username ?? "chance",
    username_resolved: init.username_resolved ?? true,
    state: init.state,
    state_label: init.state_label ?? serverStateLabel(state),
    authorized,
    granted,
    responded: init.responded ?? init.responded_at != null,
    requested_at: init.requested_at,
    responded_at: init.responded_at ?? null,
    requested_scopes: requested,
    granted_scopes: grantedScopes,
    scope_delta: { missing, extra },
    preconfigured: init.preconfigured ?? false,
    preconfiguration_id: init.preconfiguration_id,
  };
}

export function groupViews(
  groups: Array<{ key: string; org?: string } & IdpConsentPopulations>,
): IdpGroupView[] {
  return groups.map((group) => {
    const populations = populationsOf([group]);
    return {
      key: group.key,
      ...(group.org !== undefined ? { org: group.org } : {}),
      populations,
      states: statesOf(populations),
      totals: {
        total:
          populations.auto_admitted +
          populations.approved +
          populations.partial +
          populations.refused +
          populations.pending +
          populations.inconsistent,
        responded:
          populations.auto_admitted +
          populations.approved +
          populations.partial +
          populations.refused,
        pending: populations.pending,
        answered:
          populations.approved + populations.partial + populations.refused,
        subjects: 0,
      },
    };
  });
}

export function consentPayload(init: {
  populations: IdpConsentPopulations;
  totals: IdpConsentResponse["totals"];
  rows: IdpConsentRow[];
  stateFilter?: string;
  pageReturned?: number;
  truncated?: boolean;
  nextCursor?: string;
}): IdpConsentResponse {
  return {
    schema: "idp.consent.v1",
    window: WINDOW,
    org_scope: GLOBAL_SCOPE,
    state_filter: init.stateFilter ?? "",
    populations: init.populations,
    states: statesOf(init.populations),
    totals: init.totals,
    out_of_scope: { rows: 0 },
    page: {
      limit: 25,
      returned: init.pageReturned ?? init.rows.length,
      next_cursor: init.nextCursor ?? "",
      truncated: init.truncated ?? false,
      order: "id descending (keyset)",
    },
    audit: AUDIT_NOTICE,
    rows: init.rows,
  };
}
