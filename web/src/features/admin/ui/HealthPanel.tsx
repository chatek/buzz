/**
 * THE HONESTY BLOCK. This is the panel that says whether the numbers above can
 * be believed at all, and it is deliberately the least decorative screen here.
 *
 * Every count the service reports arrives with the statement that produced it
 * (`assertions[]`: name, value, query), so this panel prints the QUERY next to
 * the NUMBER. Nothing on this page is a transcribed constant.
 *
 * THREE STATES, NOT TWO. An invariant is `ok`, checked-and-FAILED, or
 * `unproven` — "we could not check this" is not "this holds", and the read model
 * reports it separately on purpose.
 */

import { CircleCheckBig, CircleX, Hourglass, KeyRound } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { IdpHealthResponse, IdpInvariant } from "../idp-types";
import {
  Absent,
  Chip,
  Kv,
  Monospace,
  NumberCard,
  SectionNote,
} from "./idp-bits";

function InvariantRow({ invariant }: { invariant: IdpInvariant }) {
  const Icon = invariant.ok
    ? CircleCheckBig
    : invariant.unproven
      ? Hourglass
      : CircleX;
  const tone = invariant.ok
    ? "text-emerald-700 dark:text-emerald-300"
    : invariant.unproven
      ? "text-amber-700 dark:text-amber-300"
      : "text-rose-700 dark:text-rose-300";
  return (
    <li
      className="flex items-start gap-2 border-b border-border/40 py-1.5 text-xs"
      data-testid={`invariant-${invariant.id}`}
      data-ok={invariant.ok ? "true" : "false"}
      data-unproven={invariant.unproven ? "true" : "false"}
    >
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", tone)} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <Monospace>{invariant.id}</Monospace>
          <span className="font-medium">
            {invariant.ok
              ? "holds"
              : invariant.unproven
                ? "could not be checked"
                : "BROKEN"}
          </span>
        </div>
        <div className="text-muted-foreground">{invariant.statement}</div>
        <div className="text-[11px] text-muted-foreground">
          {invariant.detail}
        </div>
      </div>
    </li>
  );
}

export function HealthPanel({ data }: { data: IdpHealthResponse }) {
  const broken = data.invariants.filter(
    (invariant) => !invariant.ok && !invariant.unproven,
  );
  const unproven = data.invariants.filter((invariant) => invariant.unproven);
  const guard = data.schema_guard;

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "rounded-xl border px-4 py-3",
          data.ok
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-rose-500/50 bg-rose-500/5",
        )}
        data-testid="health-status"
        data-ok={String(data.ok)}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-semibold">
            read model status: {data.status}
          </span>
          <Chip
            tone={
              data.ok
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
            }
          >
            {data.ok ? "every invariant holds" : "not green"}
          </Chip>
          <span className="text-xs text-muted-foreground">
            as of {data.as_of}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {broken.length === 0 && unproven.length === 0
            ? "Nothing on this view was checked and failed, and nothing was left unchecked."
            : `${broken.length} checked and failed, ${unproven.length} could not be checked. Both are listed below, and neither is reported as a pass.`}
        </p>
      </div>

      {data.schema_guard_error ? (
        <p
          className="rounded-lg border border-rose-500/50 bg-rose-500/5 px-3 py-2 text-xs text-rose-800 dark:text-rose-200"
          data-testid="health-guard-error"
        >
          <span className="font-medium">The schema guard refused to read:</span>{" "}
          {data.schema_guard_error}
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <NumberCard
          label="migration id"
          value={guard.migration_id}
          note={`the shape this build was compiled against: ${guard.expected_migration_id}${
            guard.migration_id === guard.expected_migration_id
              ? ""
              : " — MISMATCH, reads are refused"
          }`}
          testId="health-migration"
        />
        <NumberCard
          label="tables in schema public"
          value={guard.tables}
          note={`application ${guard.application_version}, checked ${guard.checked_at}`}
          testId="health-tables"
        />
        <NumberCard
          label="connection read-only"
          value={String(guard.default_transaction_read_only)}
          tone={
            guard.default_transaction_read_only
              ? "border-emerald-500/40"
              : "border-rose-500/50"
          }
          note="read back from the connection itself with SHOW, not assumed from the DSN"
          testId="health-readonly"
        />
        <NumberCard
          label="signing key id"
          value={data.jwks.kid || "(none)"}
          note={`${data.jwks.keys} key(s), alg ${data.jwks.alg || "unknown"}, fetched from ${data.jwks.url}`}
          testId="health-jwks"
        />
      </div>

      {data.jwks.error ? (
        <p
          className="text-xs text-rose-700 dark:text-rose-300"
          data-testid="health-jwks-error"
        >
          <KeyRound className="mr-1 inline h-3.5 w-3.5" />
          the signing key could not be read: {data.jwks.error}
        </p>
      ) : null}

      <div>
        <h3 className="text-sm font-semibold">Invariants</h3>
        <SectionNote className="mt-0.5">
          Relations, not constants: each one stays true however the numbers
          move. A count would be wrong the day after it was measured — a
          partition is not.
        </SectionNote>
        <ul className="mt-2" data-testid="health-invariants">
          {data.invariants.map((invariant) => (
            <InvariantRow key={invariant.id} invariant={invariant} />
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-semibold">
          Every number, with the statement that produced it
        </h3>
        <SectionNote className="mt-0.5">
          Nothing here is transcribed into this app: the query travels with the
          number, so any of these can be re-run by hand and compared.
        </SectionNote>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[60rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">count</th>
                <th className="py-1.5 pr-3 font-medium">value</th>
                <th className="py-1.5 pr-3 font-medium">query</th>
                <th className="py-1.5 pr-3 font-medium">note</th>
              </tr>
            </thead>
            <tbody>
              {data.assertions.map((assertion) => (
                <tr
                  key={assertion.name}
                  className="border-b border-border/40 align-top"
                  data-testid={`assertion-${assertion.name}`}
                >
                  <td className="py-2 pr-3 font-mono text-[11px]">
                    {assertion.name}
                  </td>
                  <td className="py-2 pr-3 text-sm font-semibold tabular-nums">
                    {assertion.value}
                  </td>
                  <td className="max-w-[28rem] py-2 pr-3">
                    <Monospace>{assertion.query}</Monospace>
                  </td>
                  <td className="max-w-[24rem] py-2 pr-3 text-muted-foreground">
                    {assertion.note ?? (
                      <Absent reason="this count carries no note" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">What answered</h3>
          <div className="mt-1">
            <Kv label="client projection" mono>
              {data.clients.source ?? (
                <Absent reason="no projection was loaded, so the inventory refuses rather than reports an empty estate" />
              )}
            </Kv>
            <Kv label="projection sha256" mono>
              {data.clients.sha256 ?? (
                <Absent reason="no projection was loaded" />
              )}
            </Kv>
            <Kv label="clients in the projection">
              {data.clients.live_count === undefined ? (
                <Absent reason="the payload did not report an inventory size" />
              ) : (
                data.clients.live_count
              )}
            </Kv>
            <Kv label="visible to this caller">
              {data.clients.visible_to_caller === undefined ? (
                <Absent reason="the payload did not report a visible count" />
              ) : (
                data.clients.visible_to_caller
              )}
            </Kv>
            <Kv label="outside this caller's scope">
              {data.clients.out_of_scope === undefined ? (
                <Absent reason="the payload did not report an out-of-scope count" />
              ) : (
                data.clients.out_of_scope
              )}
            </Kv>
            <Kv label="ownership registry">
              {data.clients.ownership_registry ?? (
                <Absent reason="no ownership registry is loaded" />
              )}
            </Kv>
            <Kv label="session store" mono>
              {data.sessions.backend ?? (
                <Absent reason="no session reader answered" />
              )}
            </Kv>
            <Kv label="session keys">
              {data.sessions.dbsize ?? (
                <Absent reason="no session reader answered, so no key count is claimed" />
              )}
            </Kv>
            {data.sessions.error ? (
              <Kv label="session reader error">{data.sessions.error}</Kv>
            ) : null}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold">
            What this block says about itself
          </h3>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
            <li data-testid="health-audit">
              this read is audited: sink {data.audit.sink}, persisted{" "}
              {String(data.audit.persisted)}. {data.audit.note}
            </li>
            <li>
              window applied to the consent views: {data.window.since} →{" "}
              {data.window.until}; health counts are table-wide, not windowed.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
