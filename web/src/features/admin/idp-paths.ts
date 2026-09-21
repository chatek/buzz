/**
 * The seven phase-1 paths of `/api/idp/*`, and the ONE query builder this
 * feature uses.
 *
 * Why the builder is shared with the fixtures: a staged capture is keyed by the
 * exact query string the console sends, so builder and capture must come from
 * one function. When the console asks for a read the fixture has no capture of,
 * the fixture says so (`idp-source.ts` staged fallback) instead of inventing an
 * answer.
 *
 * `MOUNT_PATH` is `admin.MountPath` in `buzz-gateway/internal/admin/http.go`.
 */

export const IDP_MOUNT_PATH = "/api/idp/";

export const IDP_PATHS = {
  clients: "/api/idp/clients",
  client: (clientId: string) =>
    `/api/idp/clients/${encodeURIComponent(clientId)}`,
  consent: "/api/idp/consent",
  consentSummary: "/api/idp/consent/summary",
  authEvents: "/api/idp/auth-events",
  sessionsSummary: "/api/idp/sessions/summary",
  health: "/api/idp/health",
} as const;

/**
 * The page size this console asks for. Well under the endpoint's clamp of 500
 * (`MaxPageLimit`), and small on purpose: every row here is another person's
 * login history, so the console shows a page and says how many rows exist
 * outside it rather than pulling the maximum.
 */
export const CONSOLE_PAGE_LIMIT = 25;

export type IdpQueryParams = Record<string, string | number | undefined>;

/** One place that turns parameters into a query string, so keys cannot drift. */
export function withQuery(path: string, query?: IdpQueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The consent page read, optionally filtered to one of the five populations. */
export function idpConsentPath(state?: string): string {
  return withQuery(IDP_PATHS.consent, {
    limit: CONSOLE_PAGE_LIMIT,
    state,
  });
}

/** The audit page read, optionally filtered to ok | failed | banned. */
export function idpAuthEventsPath(outcome?: string): string {
  return withQuery(IDP_PATHS.authEvents, {
    limit: CONSOLE_PAGE_LIMIT,
    outcome,
  });
}

/** The counts-only consent view, grouped by client and by day. */
export function idpConsentSummaryPath(): string {
  return withQuery(IDP_PATHS.consentSummary, { group_by: "both" });
}
