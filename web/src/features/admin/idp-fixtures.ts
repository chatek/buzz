/**
 * STAGED DATA — the fixture registry, and fixture 2 of 2.
 *
 * The registry is what `stagedIdpSource(id)` resolves, and it is deliberately
 * keyed by the EXACT path + query string the console sends (built by the shared
 * builders in `idp-paths.ts`), so a capture can never be reached by a request
 * shape it was not recorded for without the mismatch being visible.
 *
 * WHAT IS HERE:
 *
 *  - "a staged source that holds no payload for <path>" — the staged source
 *    throws rather than inventing an answer for a read it has no capture of.
 *  - fixture 2, "different numbers, one unclassifiable row": the capture that
 *    makes "no number is transcribed into the render path" CHECKED rather than
 *    asserted, and that exercises the defect path. Its populations sum to 33
 *    against an in-scope total of 34 — because the server's own `pending`
 *    counter counts every row with no response timestamp, including the
 *    defective one — so the console must report a table that does not add up
 *    rather than a tidy one.
 *
 * Nothing in fixture 2 was measured. Fixture 1 is in `idp-fixture-live.ts`.
 */

import type {
  IdpAuthEventsResponse,
  IdpClientsResponse,
  IdpConsentPopulations,
  IdpConsentSummaryResponse,
  IdpHealthResponse,
  IdpSessionsResponse,
} from "./idp-types";
import {
  IDP_PATHS,
  idpAuthEventsPath,
  idpConsentPath,
  idpConsentSummaryPath,
} from "./idp-paths";
import {
  AUDIT_NOTICE,
  GLOBAL_SCOPE,
  WINDOW,
  consentPayload,
  consentRow,
  groupViews,
  statesOf,
} from "./idp-fixture-builders";
import {
  liveAuthPayload,
  liveClientsPayload,
  liveConsentPayload,
  liveConsentRefusedPayload,
  liveHealthPayload,
  liveSessionsPayload,
  liveSummaryPayload,
} from "./idp-fixture-live";

// ---------------------------------------------------------------------------
// Fixture 2 — deliberately different numbers, and one defective row
// ---------------------------------------------------------------------------

/**
 * 12 / 7 / 2 / 3 / 10 with ONE unclassifiable row, in a log of 34 rows.
 *
 * THE ARITHMETIC IS THE POINT, and it is the wire contract's own arithmetic:
 * the service counts every row WITHOUT a response timestamp as `pending`,
 * including a row whose decision columns contradict that — and the same
 * defective row is also counted in `inconsistent`. So the six population fields
 * sum to 35 against an in-scope total of 34: the defect makes the partition
 * fail, visibly. The population the classifier calls "never answered" is
 * `pending - inconsistent` = 9, which this console derives in the browser and
 * labels as derived.
 */
const ALTERNATE_POPULATIONS: IdpConsentPopulations = {
  auto_admitted: 12,
  approved: 7,
  partial: 2,
  refused: 3,
  pending: 10,
  inconsistent: 1,
};

const ALTERNATE_TOTALS = {
  in_scope: 34,
  responded: 24,
  pending: 10,
  answered: 12,
  subjects: 4,
  clients: 2,
};

const alternatePayload = consentPayload({
  populations: ALTERNATE_POPULATIONS,
  totals: ALTERNATE_TOTALS,
  rows: [
    consentRow({
      id: 34,
      client_id: "alpha",
      org: "greenzone",
      state: "inconsistent",
      requested_at: "2026-09-21T10:00:00Z",
      authorized: true,
      granted: false,
      responded: false,
    }),
    consentRow({
      id: 33,
      client_id: "alpha",
      org: "greenzone",
      subject: "001122334455",
      username: "ada",
      state: "approved",
      requested_at: "2026-09-21T09:00:00Z",
      responded_at: "2026-09-21T09:00:05Z",
    }),
    consentRow({
      id: 32,
      client_id: "beta",
      subject: "665544332211",
      username: "",
      username_resolved: false,
      state: "pending",
      requested_at: "2026-09-20T09:00:00Z",
    }),
  ],
});

const alternateClientsPayload: IdpClientsResponse = {
  ...liveClientsPayload,
  as_of: "2026-09-20T12:00:00Z",
  source: {
    path: "/etc/authelia/clients.projection.yml",
    sha256: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    projection_version: 1,
    generated_by: "render-clients.py",
    source_config_sha256:
      "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    source_config_bytes: 4096,
  },
  counts: {
    total: 2,
    visible: 2,
    out_of_scope: 0,
    owned: 1,
    visible_unowned: 1,
  },
  clients: [
    {
      ...liveClientsPayload.clients[3],
      client_id: "alpha",
      client_name: "Alpha",
    },
    {
      ...liveClientsPayload.clients[5],
      client_id: "beta",
      client_name: "Beta",
    },
  ],
};

const alternateSummaryPayload: IdpConsentSummaryResponse = {
  schema: "idp.consent.summary.v1",
  window: WINDOW,
  org_scope: GLOBAL_SCOPE,
  group_by: "both",
  populations: ALTERNATE_POPULATIONS,
  states: statesOf(ALTERNATE_POPULATIONS),
  totals: ALTERNATE_TOTALS,
  out_of_scope: { rows: 0 },
  by_client: groupViews([
    { key: "alpha", org: "greenzone", ...ALTERNATE_POPULATIONS },
    {
      key: "ghost-app",
      org: "",
      auto_admitted: 0,
      approved: 0,
      partial: 0,
      refused: 0,
      pending: 0,
      inconsistent: 0,
    },
  ]),
  by_day: groupViews([{ key: "2026-09-21", ...ALTERNATE_POPULATIONS }]),
  audit: AUDIT_NOTICE,
};

const alternateAuthPayload: IdpAuthEventsResponse = {
  ...liveAuthPayload,
  totals: {
    in_scope: 20,
    ok: 15,
    failed: 4,
    banned: 1,
    username_resolved: 6,
    username_unresolved: 14,
    with_oidc_uri: 11,
    client_id_parsed: 11,
    client_id_unparsed: 0,
    usernames: 5,
    remote_ips: 4,
  },
  page: {
    ...liveAuthPayload.page,
    returned: 3,
    truncated: false,
    next_cursor: "",
  },
  rows: liveAuthPayload.rows.slice(0, 3),
};

const alternateSessionsPayload: IdpSessionsResponse = {
  ...liveSessionsPayload,
  backend: "127.0.0.1:6379",
  dbsize: 2,
  prefixes: [{ prefix: "authelia-session:", count: 2 }],
  scanned: 2,
  read_at: "2026-09-20T12:00:00Z",
};

const alternateHealthPayload: IdpHealthResponse = {
  ...liveHealthPayload,
  status: "degraded",
  ok: false,
  as_of: "2026-09-20T12:00:00Z",
  assertions: liveHealthPayload.assertions.map((assertion) =>
    assertion.name === "consent_total"
      ? { ...assertion, value: 34 }
      : assertion.name === "consent_pending"
        ? { ...assertion, value: 10 }
        : assertion,
  ),
  invariants: [
    {
      id: "schema_guard_verified",
      statement:
        "the live schema is migration 15 with exactly the expected column set of every table this service reads, verified before any read",
      ok: true,
      detail: "migration 15, 21 tables",
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
      detail: "10 pending + 24 responded = 34, total = 34",
    },
    {
      id: "five_populations_partition_the_rows",
      statement:
        "the five populations and the defect bucket together account for every row, and the defect bucket is empty",
      ok: false,
      detail:
        "12 + 7 + 2 + 3 + 9 + 1 = 34, but the five populations excluding the defect bucket sum to 33",
    },
    {
      id: "every_row_classified_exactly_once",
      statement:
        "classifying every row in Go reproduces the SQL cross-tab exactly, with scanned == total",
      ok: false,
      detail: "the scan could not be completed against this capture",
      unproven: true,
    },
    {
      id: "idp_jwks_reachable",
      statement: "the live IdP serves a JWKS document with a key id",
      ok: false,
      detail:
        'url=http://127.0.0.1:9091/api/oidc/jwks error="dial tcp 127.0.0.1:9091: connect: connection refused"',
    },
  ],
  jwks: {
    url: "http://127.0.0.1:9091/api/oidc/jwks",
    kid: "",
    alg: "",
    keys: 0,
    fetched_at: "2026-09-20T12:00:00Z",
    error: "dial tcp 127.0.0.1:9091: connect: connection refused",
  },
  clients: {
    source: "/etc/authelia/clients.projection.yml",
    sha256: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    live_count: 2,
    visible_to_caller: 2,
    out_of_scope: 0,
    ownership_registry: "1 owned client",
  },
  sessions: {
    backend: "127.0.0.1:6379",
    dbsize: 2,
    prefixes: [{ prefix: "authelia-session:", count: 2 }],
    other: 0,
    scanned: 2,
  },
};

/**
 * One recorded capture. The payloads are keyed by the EXACT request path and
 * query string the console sends, built by the shared builders in
 * `idp-paths.ts`, so a capture can never be reached by a request shape it was
 * not recorded for without the mismatch being visible.
 */
export type StagedFixture = {
  id: string;
  label: string;
  /** What this capture is, in one sentence a reader can quote. */
  captureNote: string;
  payloads: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const LIVE_FIXTURE: StagedFixture = {
  id: "live-2026-09-21",
  label: "Captured live cross-tab, 2026-09-21",
  captureNote:
    "recorded 2026-09-21T16:35Z from the live read model (J14 READ_MODEL.md §2). 130 auto-admitted, 99 approved, 5 partly approved, 1 refused, 46 never answered, 0 unclassifiable. Client names and organizations are illustrative; the population counts are the measured ones.",
  payloads: {
    [IDP_PATHS.clients]: liveClientsPayload,
    [idpConsentPath()]: liveConsentPayload,
    [idpConsentPath("refused")]: liveConsentRefusedPayload,
    [idpConsentSummaryPath()]: liveSummaryPayload,
    [idpAuthEventsPath()]: liveAuthPayload,
    [IDP_PATHS.sessionsSummary]: liveSessionsPayload,
    [IDP_PATHS.health]: liveHealthPayload,
  },
};

const ALTERNATE_FIXTURE: StagedFixture = {
  id: "alternate-with-defect",
  label: "Different numbers, one unclassifiable row",
  captureNote:
    "a SYNTHETIC capture with different numbers (12 auto-admitted, 7 approved, 2 partly approved, 3 refused, 9 never answered, 1 unclassifiable) and one deliberately defective row, so the console can be shown reporting a population table that does not add up. Nothing here was measured.",
  payloads: {
    [IDP_PATHS.clients]: alternateClientsPayload,
    [idpConsentPath()]: alternatePayload,
    [idpConsentSummaryPath()]: alternateSummaryPayload,
    [idpAuthEventsPath()]: alternateAuthPayload,
    [IDP_PATHS.sessionsSummary]: alternateSessionsPayload,
    [IDP_PATHS.health]: alternateHealthPayload,
  },
};

const FIXTURES: Record<string, StagedFixture> = {
  [LIVE_FIXTURE.id]: LIVE_FIXTURE,
  [ALTERNATE_FIXTURE.id]: ALTERNATE_FIXTURE,
  live: LIVE_FIXTURE,
  alternate: ALTERNATE_FIXTURE,
};

export const STAGED_FIXTURE_IDS = [
  LIVE_FIXTURE.id,
  ALTERNATE_FIXTURE.id,
] as const;

export const DEFAULT_STAGED_FIXTURE_ID = LIVE_FIXTURE.id;

export function stagedFixture(id: string): StagedFixture {
  const found = FIXTURES[id];
  if (!found) {
    throw new Error(
      `unknown staged fixture "${id}"; known: ${STAGED_FIXTURE_IDS.join(", ")}`,
    );
  }
  return found;
}
