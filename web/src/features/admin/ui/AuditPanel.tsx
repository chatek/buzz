/**
 * THE LOGIN AUDIT, and the session histogram.
 *
 * THE HONEST LIMITS OF THIS VIEW, written down where a reader sees them:
 *
 *  - NO DENIAL REASON. The audit has `successful` and `banned`; the cause of a
 *    refusal is a journal line, not a column. The payload carries a sentence
 *    saying so and this panel prints that sentence rather than inventing a cause.
 *  - NO REQUEST URI. Only the PATH is returned; the query string carries
 *    `code_challenge` and `state` and is dropped in SQL.
 *  - NO PER-USER SESSIONS. The session histogram is `DBSIZE` plus a prefix scan.
 *    Attributing a key to a human needs the key's payload, and the key IS the
 *    live cookie value, so that field is the sentence "NOT BUILT" — rendered as
 *    that sentence, never as zero users.
 *  - MOST LOGIN NAMES DO NOT RESOLVE. The subject map keys on the bare uid while
 *    a login name is usually the full address (MEASURED 2026-09-21: 101 of 346
 *    rows resolve). That is reported as a partition, not hidden.
 */

import { CircleCheckBig, CircleSlash, TriangleAlert } from "lucide-react";

import { toIdpFailure, type IdpSource } from "../idp-source";
import type { IdpAuthEventsResponse, IdpSessionsResponse } from "../idp-types";
import { useIdpSessions } from "../use-idp-admin";
import { IdpClosedNotice } from "./IdpClosedNotice";
import {
  Absent,
  Chip,
  CountCard,
  Monospace,
  NumberCard,
  SectionNote,
} from "./idp-bits";

const OUTCOME_TONE: Record<string, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  banned:
    "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
};

const OUTCOME_ICON: Record<string, typeof CircleCheckBig> = {
  ok: CircleCheckBig,
  failed: CircleSlash,
  banned: TriangleAlert,
};

function SessionsBlock({ source }: { source: IdpSource }) {
  const sessions = useIdpSessions(source);
  return (
    <div>
      <h3 className="text-sm font-semibold">
        IdP sessions (global admin only)
      </h3>
      <SectionNote className="mt-0.5">
        This endpoint requires the global admin scope in its own right, so a
        refusal here is about this caller, not about the read model.
      </SectionNote>
      <div className="mt-2">
        {sessions.isError ? (
          <IdpClosedNotice
            failure={toIdpFailure(sessions.error)}
            onRetry={() => void sessions.refetch()}
          />
        ) : sessions.isPending ? (
          <SectionNote>Reading the session histogram…</SectionNote>
        ) : sessions.data ? (
          <SessionsData data={sessions.data} />
        ) : null}
      </div>
    </div>
  );
}

function SessionsData({ data }: { data: IdpSessionsResponse }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <NumberCard
          label="keys in the session store"
          value={data.dbsize}
          note={`DBSIZE on ${data.backend} — every key in the database, not only session keys`}
          testId="sessions-dbsize"
        />
        <NumberCard
          label="keys walked by the scan"
          value={data.scanned}
          note="the reader's receipt: a short scan would be visible here rather than reported as zero"
          testId="sessions-scanned"
        />
        <NumberCard
          label="keys under no known prefix"
          value={data.other}
          note="arithmetic: DBSIZE minus the buckets below"
          testId="sessions-other"
        />
        <NumberCard
          label="read at"
          value={data.read_at}
          note="a count is a measurement with a timestamp, not a constant"
        />
      </div>
      <ul className="text-xs text-muted-foreground">
        {data.prefixes.map((prefix) => (
          <li key={prefix.prefix}>
            <Monospace>{prefix.prefix}</Monospace> {prefix.count}
          </li>
        ))}
        {data.prefixes.length === 0 ? (
          <li>
            <Absent reason="no prefix bucket was reported" />
          </li>
        ) : null}
      </ul>
      <p
        className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11px] text-muted-foreground"
        data-testid="sessions-attribution"
      >
        <span className="font-medium">Per-user attribution:</span>{" "}
        {data.per_user_attribution}
      </p>
      <SectionNote>
        Commands used: {data.commands.join(" · ")}. Nothing is written to Redis
        by this surface.
      </SectionNote>
    </div>
  );
}

export function AuditPanel({
  data,
  source,
}: {
  data: IdpAuthEventsResponse;
  source: IdpSource;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <CountCard
          absentReason="the payload did not report an in-scope attempt count"
          label="login attempts in scope"
          value={data.totals.in_scope}
          note="every attempt recorded in this window, whatever its outcome"
          testId="audit-total"
        />
        <CountCard
          absentReason="the payload did not report a succeeded count"
          label="succeeded"
          value={data.totals.ok}
          tone="border-emerald-500/40"
          note="successful and not banned"
          testId="audit-ok"
        />
        <CountCard
          absentReason="the payload did not report a failed count"
          label="failed"
          value={data.totals.failed}
          tone="border-rose-500/40"
          note="the reason is not in this database; see the notice below"
          testId="audit-failed"
        />
        <CountCard
          absentReason="the payload did not report a banned count"
          label="banned"
          value={data.totals.banned}
          tone="border-fuchsia-500/50"
          note="counted once, never also as a failure"
          testId="audit-banned"
        />
        <CountCard
          absentReason="the payload did not report an OIDC attempt count"
          label="through an OIDC callback"
          value={data.totals.with_oidc_uri}
          note="the only rows an org-scoped caller can attribute to a client"
          testId="audit-oidc"
        />
        <CountCard
          absentReason="the payload did not report a resolved-name count"
          label="login names resolved to a uid"
          value={data.totals.username_resolved}
          note="the subject map keys on the bare uid; an address does not resolve here"
          testId="audit-resolved"
        />
        <CountCard
          absentReason="the payload did not report an unresolved-name count"
          label="login names not resolved"
          value={data.totals.username_unresolved}
          note="reported, not hidden: resolving an address to a uid needs the directory"
          testId="audit-unresolved"
        />
        <CountCard
          absentReason="the payload did not report a distinct-name count"
          label="distinct names"
          value={data.totals.usernames}
          note="as typed, before any resolution"
          testId="audit-usernames"
        />
      </div>

      <p
        className="rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-xs"
        data-testid="audit-denial-reason"
      >
        <span className="font-medium">
          No denial reason is shown, and none is claimed:
        </span>{" "}
        {data.denial_reason}
      </p>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Attempts</h3>
          <span className="text-xs text-muted-foreground">
            outcome filter applied by the service:{" "}
            {data.outcome_filter === "" ? (
              <span>none</span>
            ) : (
              <Monospace>{data.outcome_filter}</Monospace>
            )}
          </span>
        </div>
        <SectionNote className="mt-0.5">
          Only the request PATH is shown. The query string is dropped by the
          service before the row is returned, because it carries the challenge
          and the state of the login attempt.
        </SectionNote>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">row</th>
                <th className="py-1.5 pr-3 font-medium">when</th>
                <th className="py-1.5 pr-3 font-medium">outcome</th>
                <th className="py-1.5 pr-3 font-medium">name as typed</th>
                <th className="py-1.5 pr-3 font-medium">auth type</th>
                <th className="py-1.5 pr-3 font-medium">source address</th>
                <th className="py-1.5 pr-3 font-medium">client</th>
                <th className="py-1.5 pr-3 font-medium">request</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td className="py-3 text-muted-foreground" colSpan={8}>
                    The service returned a page with no rows for this filter.
                    The totals above still describe the whole filter set.
                  </td>
                </tr>
              ) : null}
              {data.rows.map((row) => {
                const Icon = OUTCOME_ICON[row.outcome] ?? TriangleAlert;
                return (
                  <tr
                    key={row.id}
                    className="border-b border-border/40 align-top"
                    data-testid={`audit-row-${row.id}`}
                  >
                    <td className="py-2 pr-3 font-mono text-[11px]">
                      {row.id}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-[11px] text-muted-foreground">
                      {row.time}
                    </td>
                    <td className="py-2 pr-3">
                      <Chip tone={OUTCOME_TONE[row.outcome]}>
                        <Icon className="h-3 w-3" />
                        {row.outcome}
                      </Chip>
                    </td>
                    <td className="py-2 pr-3">
                      <Monospace>{row.username}</Monospace>
                      {row.username_resolved ? (
                        row.resolved_uid ? (
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            resolves to {row.resolved_uid}
                          </span>
                        ) : null
                      ) : (
                        <span className="ml-1">
                          <Absent reason="not on the subject map, so no uid is claimed" />
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {row.auth_type}
                    </td>
                    <td className="py-2 pr-3">
                      <Monospace>{row.remote_ip}</Monospace>
                    </td>
                    <td className="py-2 pr-3">
                      {row.client_id ? (
                        <>
                          <Monospace>{row.client_id}</Monospace>
                          {row.org ? (
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              {row.org}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <Absent reason="this attempt carries no client id — it did not go through an OIDC callback" />
                      )}
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-muted-foreground">
                      {row.request_method}{" "}
                      <Monospace>{row.request_path}</Monospace>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <SectionNote className="mt-2">
          Page: {data.page.returned} rows returned, limit {data.page.limit},{" "}
          {data.page.truncated
            ? `more rows exist (next cursor ${data.page.next_cursor})`
            : "this is the whole page"}
          . Rows outside your scope:{" "}
          {data.out_of_scope.rows === undefined ? (
            <Absent reason="the payload did not report an out-of-scope row count" />
          ) : (
            `${data.out_of_scope.rows} — counted, never listed`
          )}
          .
        </SectionNote>
      </div>

      <SessionsBlock source={source} />
    </div>
  );
}
