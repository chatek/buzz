/**
 * THE CONSENT VIEW — and the reason this whole console exists.
 *
 * The rule this panel implements, in one sentence: `responded_at` is asked FIRST,
 * so the six populations stay six, and there is NO SINGLE "consents" NUMBER
 * anywhere on this page.
 *
 * Why that matters, from the read model (`.prime/handoff/idp-build/j14/
 * READ_MODEL.md` §2, MEASURED 2026-09-21): the live grant log holds 281 rows, of
 * which 130 were admitted automatically with nobody asked, 99 were approved,
 * 5 were partly approved, 1 was refused and 46 were never answered. Only 105 of
 * those 281 rows carry a real user answer. A screen that prints "281 consents"
 * reports 46 abandoned logins as user decisions and 130 automatic admissions as
 * approvals. So this panel prints the row count as a ROW count, decomposes it
 * immediately, and computes "real user answers" as approved + partly approved +
 * refused.
 */

import { cn } from "@/shared/lib/cn";
import type { IdpConsentResponse, IdpConsentState } from "../idp-types";
import {
  CONSENT_STATE_ORDER,
  type ConsistencyLine,
  answeredCount,
  consentConsistency,
  presentationOf,
} from "../consent-classification";
import {
  Absent,
  Chip,
  CountCard,
  Monospace,
  NumberCard,
  SectionNote,
} from "./idp-bits";

const FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  {
    value: "",
    label:
      "no filter (the endpoint's own default: rows with a response timestamp)",
  },
  ...CONSENT_STATE_ORDER.map((state) => ({
    value: state,
    label: presentationOf(state)?.heading ?? state,
  })),
];

function ConsistencyList({ lines }: { lines: ConsistencyLine[] }) {
  return (
    <ul className="space-y-1" data-testid="consent-consistency">
      {lines.map((line) => (
        <li
          key={line.id}
          className={cn(
            "flex flex-wrap items-baseline gap-2 text-[11px]",
            line.ok
              ? "text-muted-foreground"
              : line.unproven
                ? "text-amber-700 dark:text-amber-300"
                : "text-rose-700 dark:text-rose-300",
          )}
          data-testid={`consent-consistency-${line.id}`}
          data-ok={line.ok ? "true" : "false"}
        >
          <Chip
            tone={
              line.ok
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : line.unproven
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
            }
          >
            {line.ok ? "holds" : line.unproven ? "could not check" : "BROKEN"}
          </Chip>
          <span>{line.statement}</span>
          <span className="text-muted-foreground">— {line.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function ConsentPanel({
  data,
  stateFilter,
  onStateFilterChange,
}: {
  data: IdpConsentResponse;
  stateFilter: string;
  onStateFilterChange: (next: string) => void;
}) {
  const populations = data.populations;
  const answered = answeredCount(populations);
  const consistency = consentConsistency({
    populations,
    totals: data.totals,
    states: data.states,
  });
  const labelOf = (state: IdpConsentState) =>
    data.states.find((entry) => entry.state === state)?.label ?? null;
  const stagedFilterMismatch =
    data.state_filter !== stateFilter ? data.state_filter : null;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border/70 bg-card/40 px-3 py-2">
        <SectionNote>
          The first question asked of every row is{" "}
          <span className="font-medium">whether anybody answered it</span> — not
          whether it was authorised. A row with no response timestamp is an
          abandoned login: it is not a refusal, and the count below is what
          stops it from being read as one. Each population is shown separately,
          and this page does not print a single total for decisions.
        </SectionNote>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <CountCard
          absentReason="the payload did not report an in-scope row total, so no row count is shown"
          label="rows in the grant log (in scope)"
          note="every row of the log in this window — a row count, not a count of decisions"
          testId="consent-total-rows"
          value={data.totals.in_scope}
        />
        <NumberCard
          label="real user answers"
          value={answered}
          tone="border-emerald-500/40"
          note="approved + partly approved + refused. Not the row count, and not a count of rows the service wrote a decision column for."
          testId="consent-answered"
        />
        <CountCard
          absentReason="the payload did not report a responded count"
          label="rows with a response timestamp"
          note="includes the automatic admissions, where a timestamp was written and no human acted"
          testId="consent-responded"
          value={data.totals.responded}
        />
        <NumberCard
          label="rows with no response timestamp"
          value={populations.pending}
          tone="border-zinc-400/50"
          note="shown as the service counts it: every row with no response recorded, which includes an unclassifiable row when one exists. An abandoned login is not a refusal."
          testId="consent-pending"
        />
        <CountCard
          absentReason="the payload did not report a distinct-subject count"
          label="people (distinct subjects)"
          note="opaque subjects, not login names"
          testId="consent-subjects"
          value={data.totals.subjects}
        />
        <CountCard
          absentReason="the payload did not report a distinct-client count"
          label="clients present in the log"
          note="client ids with at least one row, which can include a client no longer in the inventory"
          testId="consent-clients"
          value={data.totals.clients}
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold">
          The five populations, and the defect bucket
        </h3>
        <SectionNote className="mt-0.5">
          One row per population. A zero is shown, not omitted: an absent bucket
          and an empty bucket are different facts. The final row is a defect
          state, not a population — it must be zero.
        </SectionNote>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">population</th>
                <th className="py-1.5 pr-3 font-medium">rows</th>
                <th className="py-1.5 pr-3 font-medium">a human decided?</th>
                <th className="py-1.5 pr-3 font-medium">
                  what the service calls it
                </th>
                <th className="py-1.5 pr-3 font-medium">what to do</th>
              </tr>
            </thead>
            <tbody>
              {CONSENT_STATE_ORDER.map((state) => {
                const view = presentationOf(state);
                if (!view) return null;
                const label = labelOf(state);
                return (
                  <tr
                    key={state}
                    className="border-b border-border/40 align-top"
                    data-testid={`consent-population-${state}`}
                  >
                    <td className="py-2 pr-3">
                      <Chip tone={view.tone}>{view.heading}</Chip>
                    </td>
                    <td
                      className="py-2 pr-3 align-top text-sm font-semibold tabular-nums"
                      data-testid={`consent-population-count-${state}`}
                    >
                      {populations[state]}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      {view.answered ? "yes" : "no"}
                    </td>
                    <td className="py-2 pr-3 align-top text-muted-foreground">
                      {label ?? (
                        <Absent reason="the payload did not name this population" />
                      )}
                    </td>
                    <td className="max-w-[22rem] py-2 pr-3 align-top text-muted-foreground">
                      {view.guidance}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <SectionNote className="mt-2">
          <span className="font-medium">
            {answered}
            {data.totals.in_scope === undefined
              ? null
              : ` of ${data.totals.in_scope}`}
          </span>{" "}
          {data.totals.in_scope === undefined ? (
            <>
              log rows in this filter set carry an answer from a person — the
              payload did not report an in-scope row total, so no denominator is
              shown rather than a made-up one.{" "}
            </>
          ) : (
            <>
              log rows in this filter set carry an answer from a person. The
              rest{" "}
            </>
          )}
          were admitted automatically or never answered at all, and neither of
          those is a decision: reading the log row count as a count of decisions
          is exactly the misreport this view exists to prevent.
        </SectionNote>
        {populations.inconsistent > 0 ? (
          <SectionNote className="mt-2" testId="consent-pending-derived">
            <span className="font-medium">
              Derived here, from the two numbers above:
            </span>{" "}
            {Math.max(populations.pending - populations.inconsistent, 0)} rows
            were never answered once the unclassifiable rows are subtracted. The
            service counts a defective row in the no-response figure as well as
            in the defect bucket, so the never-answered number is an upper bound
            until the defect is gone. This figure is computed in this browser
            and labelled as derived — it is not reported as a fact by the
            service.
          </SectionNote>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">
            Consistency, recomputed here
          </h3>
          <SectionNote className="mt-0.5">
            Computed in this browser from the payload. The service checks the
            same relations as invariants on the health view; these lines are
            what a screenshot can be trusted to show.
          </SectionNote>
          <div className="mt-2">
            <ConsistencyList lines={consistency} />
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold">
            Scope, window and the audit of this read
          </h3>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            <li>
              scope: <Monospace>{data.org_scope.scope}</Monospace>{" "}
              {data.org_scope.global
                ? "(global admin: every client)"
                : `(organizations ${data.org_scope.orgs.join(", ") || "none"})`}
            </li>
            <li>
              window: {data.window.since} → {data.window.until} (
              {data.window.default_days}-day default). {data.window.note ?? ""}
            </li>
            <li data-testid="consent-out-of-scope">
              rows outside your scope:{" "}
              {data.out_of_scope.rows === undefined ? (
                <Absent reason="the payload did not report an out-of-scope row count" />
              ) : (
                `${data.out_of_scope.rows} — counted, never listed`
              )}
            </li>
            <li data-testid="consent-aged-out">
              rows inside your scope but outside the window:{" "}
              {data.window.aged_out_of_window}
            </li>
            <li data-testid="consent-audit">
              this read is audited: sink {data.audit.sink}, persisted{" "}
              {String(data.audit.persisted)}. {data.audit.note}
            </li>
          </ul>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Rows</h3>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            population filter
            <select
              className="rounded-md border border-border/70 bg-background px-2 py-1 text-xs"
              data-testid="consent-state-filter"
              onChange={(event) => onStateFilterChange(event.target.value)}
              value={stateFilter}
            >
              {FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <SectionNote className="mt-0.5">
          The counts above are the WHOLE cross-tab for the filter set, even when
          a single population is selected: the service drops the state predicate
          at the call site so a filtered view cannot hide the other populations.
          The applied filter is the one the payload echoes:{" "}
          {data.state_filter === "" ? (
            <span>none</span>
          ) : (
            <Monospace>{data.state_filter}</Monospace>
          )}
          .
        </SectionNote>
        {stagedFilterMismatch !== null ? (
          <p
            className="mt-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            data-testid="consent-staged-filter-note"
          >
            Staged capture: this fixture has a recorded variant only for a few
            filters. You selected a population it has no capture for, so what is
            shown is the unfiltered capture — which the payload echoes as{" "}
            <Monospace>
              {data.state_filter === "" ? "(none)" : data.state_filter}
            </Monospace>
            . The counts above are unaffected either way.
          </p>
        ) : null}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">row</th>
                <th className="py-1.5 pr-3 font-medium">requested</th>
                <th className="py-1.5 pr-3 font-medium">answered</th>
                <th className="py-1.5 pr-3 font-medium">client</th>
                <th className="py-1.5 pr-3 font-medium">who</th>
                <th className="py-1.5 pr-3 font-medium">population</th>
                <th className="py-1.5 pr-3 font-medium">
                  scopes requested → granted
                </th>
                <th className="py-1.5 pr-3 font-medium">difference</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td className="py-3 text-muted-foreground" colSpan={8}>
                    The service returned a page with no rows for this filter,
                    and the counts above still describe the whole filter set. An
                    empty page is not an empty population — compare the two
                    before concluding there is nothing here.
                  </td>
                </tr>
              ) : null}
              {data.rows.map((row) => {
                const view = presentationOf(row.state);
                return (
                  <tr
                    key={row.id}
                    className="border-b border-border/40 align-top"
                    data-testid={`consent-row-${row.id}`}
                  >
                    <td className="py-2 pr-3 font-mono text-[11px]">
                      {row.id}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-[11px] text-muted-foreground">
                      {row.requested_at}
                    </td>
                    <td className="py-2 pr-3 text-[11px]">
                      {row.responded_at ? (
                        <span className="text-muted-foreground">
                          {row.responded_at}
                        </span>
                      ) : (
                        <Absent reason="no response recorded — the screen was shown and never answered" />
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Monospace>{row.client_id}</Monospace>
                      {row.org ? (
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          {row.org}
                        </span>
                      ) : (
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          unowned
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {row.username_resolved ? (
                        row.username
                      ) : (
                        <>
                          <Monospace>{row.subject}</Monospace>{" "}
                          <Absent reason="not resolved to a login name" />
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Chip tone={view?.tone}>
                        {view?.heading ?? row.state}
                      </Chip>
                      {row.preconfigured ? (
                        <div className="mt-1">
                          <Chip tone="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                            pre-authorised (row {row.preconfiguration_id}) — a
                            pre-authorisation is not an approval and is never
                            merged into a population
                          </Chip>
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-[11px]">
                      {row.requested_scopes.length === 0 ? (
                        <Absent reason="no scope request was recorded on this row" />
                      ) : (
                        <span className="text-muted-foreground">
                          {row.requested_scopes.join(" ")}{" "}
                          <span className="font-medium">→</span>{" "}
                          {row.granted_scopes.length === 0
                            ? "nothing granted"
                            : row.granted_scopes.join(" ")}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-[11px]">
                      {row.scope_delta.missing.length === 0 &&
                      row.scope_delta.extra.length === 0 ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <>
                          {row.scope_delta.missing.length > 0 ? (
                            <div className="text-amber-700 dark:text-amber-300">
                              asked for, not granted:{" "}
                              {row.scope_delta.missing.join(" ")}
                            </div>
                          ) : null}
                          {row.scope_delta.extra.length > 0 ? (
                            <div className="text-sky-700 dark:text-sky-300">
                              granted, not asked for:{" "}
                              {row.scope_delta.extra.join(" ")}
                            </div>
                          ) : null}
                        </>
                      )}
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
            ? `more rows exist (next cursor ${data.page.next_cursor}) — this console does not page yet, which is DEFERRED`
            : "this is the whole page"}
          . Order: {data.page.order}. No column of this table carries a secret:
          the payload has no field for the submitted form, the request handle or
          the session data.
        </SectionNote>
      </div>
    </div>
  );
}
