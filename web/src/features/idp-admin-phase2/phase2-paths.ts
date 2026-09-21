/**
 * The FOUR phase-2 paths — the write surface of the IdP admin console.
 *
 * READ FROM THE CONTRACT, NOT INVENTED. Every string below is one of the four
 * endpoints of `.prime/handoff/idp-build/j19/PHASE2_DESIGN.md` §3 (rows 8-11 of
 * `docs/... ORG_SCOPED_ADMIN_DESIGN.md` §4.2):
 *
 *   POST  /api/idp/clients                     create from a structured object
 *   PATCH /api/idp/clients/{client_id}         modify an existing client
 *   POST  /api/idp/clients/{client_id}/apply   run the privileged applier
 *   GET   /api/idp/changes                     read the change log
 *
 * The `/api/idp/` prefix and the query builder are IMPORTED from the phase-1
 * `../admin/idp-paths.ts` rather than copied. One reason, and it is load-bearing: a
 * staged capture is keyed by the exact query string the console sends, so
 * builder and capture must come from one function. A second copy of the builder
 * here would be a second answer to that question.
 *
 * `{client_id}` is percent-encoded here and nowhere else. The id becomes a URL
 * path segment and, on the server, a path component inside the staging
 * directory (`plan.go` bound it at `^[a-z0-9][a-z0-9._-]{1,127}$`). Encoding is
 * the cheap side of that argument, and it costs nothing for a well-formed id.
 */

import { CONSOLE_PAGE_LIMIT, withQuery } from "../admin/idp-paths";

export const PHASE2_PATHS = {
  createClient: "/api/idp/clients",
  patchClient: (clientId: string) =>
    `/api/idp/clients/${encodeURIComponent(clientId)}`,
  applyClient: (clientId: string) =>
    `/api/idp/clients/${encodeURIComponent(clientId)}/apply`,
  changes: "/api/idp/changes",
} as const;

/**
 * The header every MUTATING phase-2 endpoint requires (design §4.1). Spelled
 * once, because a header name typo is a `400` the console cannot explain and a
 * second spelling in a second file is how that happens.
 *
 * Why the console carries this at all: on `/apply` the header is what stops a
 * repeated request from restarting the IdP a second time. Missing ⇒ `400`; a
 * repeat with the same key and the same body returns the FIRST result and runs
 * nothing (§4.1).
 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * The key grammar the server enforces (§4.1): 8-200 characters of
 * `A-Za-z0-9._~-`. The console checks it before sending so a caller-chosen key
 * fails here, with the grammar named, rather than as a bare `400`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{8,200}$/;

/** The reason bound §4.2 fixes at 200 characters (`plan.go` MaxReasonLen). */
export const PHASE2_MAX_REASON_LEN = 200;

/**
 * The path TEMPLATES, exactly as the design writes them. They are for display
 * and for the `/changes` row's `next` field; anything that calls an endpoint
 * uses `PHASE2_PATHS`, where the id is already encoded.
 */
export const PHASE2_PATH_TEMPLATES = {
  create: "/api/idp/clients",
  patch: "/api/idp/clients/{client_id}",
  apply: "/api/idp/clients/{client_id}/apply",
  changes: "/api/idp/changes",
} as const;

export type Phase2ChangesQuery = {
  clientId?: string;
  /** Keyset cursor from the previous page; opaque to this console. */
  cursor?: string;
  limit?: number;
  since?: string;
};

/**
 * The change-log read (design §3.4). One builder, so the console cannot send a
 * query string the endpoint does not accept and cannot drift the parameter
 * names (`client_id`, `since`, `limit`, `cursor`) from the Go source.
 *
 * The page limit is phase 1's `CONSOLE_PAGE_LIMIT`, reused on purpose: 25 rows
 * per page is the one page size this console asks for, and the endpoint clamps
 * far higher (`MaxPageLimit` 500). The response's `page.truncated` and
 * `totals.out_of_scope` are what tell a reader how much is outside the page.
 */
export function phase2ChangesPath(query?: Phase2ChangesQuery): string {
  return withQuery(PHASE2_PATHS.changes, {
    client_id: query?.clientId,
    since: query?.since,
    limit: query?.limit ?? CONSOLE_PAGE_LIMIT,
    cursor: query?.cursor,
  });
}

/** Does this key satisfy the grammar the endpoint enforces before it looks up anything? */
export function idempotencyKeyIsWellFormed(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}
