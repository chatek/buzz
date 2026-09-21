/**
 * THE ADMIN CONSOLE (phase 1, READ-ONLY).
 *
 * THE SURFACE THE OPERATOR ACTUALLY LOOKS AT. Four views:
 *
 *   clients  the OIDC client inventory, its projection identity, and the
 *            inventory-versus-grant-log cross-check
 *   consent  the grant log under the FIVE-way classification, with `responded_at`
 *            asked first and no single "consents" number anywhere
 *   audit    the login audit and the session histogram
 *   health   the honesty block: invariants, every count with its query
 *
 * READ-ONLY IS STRUCTURAL, NOT A PROMISE: the service has no mutating endpoint
 * at all and answers 405 to any method that is not GET or HEAD
 * (`buzz-gateway/internal/admin/http.go`), and phase 2's write endpoints are not
 * implemented. Nothing on this page can change anything.
 *
 * TODAY EVERY LIVE READ IS REFUSED, and the page says so rather than looking
 * broken: the live gateway runs with a nil admission function and the endpoints
 * are not mounted yet. To see the views before admission lands, open the page
 * with a staged capture: `?fixture=live-2026-09-21` or
 * `?fixture=alternate-with-defect`. Both are labelled "staged data" on every
 * panel, and the banner names the capture.
 *
 * REACHING THIS PAGE. The route is registered in `src/app/routes.ts`, which has
 * a single writer (the lead): the one-line insertion this file needs is written
 * down in `.prime/handoff/idp-build/j18/CONSOLE_PHASE1.md` rather than applied
 * here. Until that line is in the route table, a BUILT app has no /admin route.
 */

import * as React from "react";
import { LockKeyhole } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { useSession } from "@/shared/lib/session";
import { Badge } from "@/shared/ui/badge";

import type { IdpFailure, IdpSource } from "../idp-source";
import type {
  IdpAuthEventsResponse,
  IdpClientsResponse,
  IdpConsentResponse,
  IdpHealthResponse,
} from "../idp-types";
import { STAGED_FIXTURE_IDS } from "../idp-fixtures";
import {
  useConsoleSource,
  useIdpAuthEvents,
  useIdpClients,
  useIdpConsent,
  useIdpHealth,
} from "../use-idp-admin";
import { AuditPanel } from "./AuditPanel";
import { ClientsPanel } from "./ClientsPanel";
import { ConsentPanel } from "./ConsentPanel";
import { HealthPanel } from "./HealthPanel";
import { IdpClosedNotice } from "./IdpClosedNotice";
import { PanelFrame } from "./PanelFrame";
import { Monospace, SectionNote } from "./idp-bits";

type TabId = "clients" | "consent" | "audit" | "health";

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  {
    id: "clients",
    label: "Clients",
    hint: "the OIDC inventory and its identity",
  },
  { id: "consent", label: "Consent", hint: "the grant log, five ways" },
  { id: "audit", label: "Login audit", hint: "attempts and sessions" },
  { id: "health", label: "Health", hint: "can these numbers be believed" },
];

function isTabId(value: string | null): value is TabId {
  return value !== null && TABS.some((tab) => tab.id === value);
}

function ClientsTab({ source }: { source: IdpSource }) {
  const clients = useIdpClients(source);
  return (
    <PanelFrame<IdpClientsResponse>
      description="Every OIDC client this service knows, scoped to the caller's organizations, with the identity of the projection that answered."
      path="/api/idp/clients"
      query={clients}
      source={source}
      title="The client inventory"
    >
      {(data) => <ClientsPanel data={data} source={source} />}
    </PanelFrame>
  );
}

function ConsentTab({ source }: { source: IdpSource }) {
  const [stateFilter, setStateFilter] = React.useState("");
  const consent = useIdpConsent(source, stateFilter || undefined);
  return (
    <PanelFrame<IdpConsentResponse>
      description="The grant log, classified five ways with the response timestamp asked first. No single total of decisions appears here, by design."
      path={stateFilter ? `/api/idp/consent (filtered)` : "/api/idp/consent"}
      query={consent}
      source={source}
      title="Consent and approvals"
    >
      {(data) => (
        <ConsentPanel
          data={data}
          onStateFilterChange={setStateFilter}
          stateFilter={stateFilter}
        />
      )}
    </PanelFrame>
  );
}

function AuditTab({ source }: { source: IdpSource }) {
  const events = useIdpAuthEvents(source);
  return (
    <PanelFrame<IdpAuthEventsResponse>
      description="Every login attempt in the window, with the outcome the database records and no invented reason."
      path="/api/idp/auth-events"
      query={events}
      source={source}
      title="Login audit and sessions"
    >
      {(data) => <AuditPanel data={data} source={source} />}
    </PanelFrame>
  );
}

function HealthTab({ source }: { source: IdpSource }) {
  const health = useIdpHealth(source);
  return (
    <PanelFrame<IdpHealthResponse>
      description="The invariants that decide whether the other views can be believed, and every count the service reports with the statement that produced it."
      path="/api/idp/health"
      query={health}
      source={source}
      title="Read model health"
    >
      {(data) => <HealthPanel data={data} />}
    </PanelFrame>
  );
}

function CallerLine() {
  const { status, principal } = useSession();
  return (
    <SectionNote className="mt-1">
      signed-in identity:{" "}
      {status === "unknown"
        ? "being restored from the tab's session"
        : principal
          ? `${principal.email ?? principal.preferredUsername ?? principal.name ?? principal.subject} (display only)`
          : "none — you are browsing anonymously, which is the expected state"}
      . The console's authority does not come from this identity: the service
      re-resolves the caller's directory groups on every request and derives the
      client scope from the ownership registry, never from a token claim.
    </SectionNote>
  );
}

export function AdminConsolePage() {
  const { source, fixtureError, search } = useConsoleSource();
  const [tab, setTab] = React.useState<TabId>(() =>
    isTabId(search.tab) ? search.tab : "consent",
  );

  if (fixtureError || !source) {
    const failure: IdpFailure = {
      kind: "not_found",
      status: null,
      path: `?fixture=${search.fixture ?? ""}`,
      title: "Unknown staged capture",
      meaning:
        "The fixture named on this URL does not exist, so no source could be built. The console refuses rather than quietly reading live data under a URL that asked for staged data.",
      evidence: `${fixtureError ?? "no source"} — known captures: ${STAGED_FIXTURE_IDS.join(", ")}`,
    };
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <IdpClosedNotice failure={failure} />
      </div>
    );
  }

  const staged = source.kind === "staged";

  return (
    <div className="mx-auto w-full max-w-[110rem] px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            Identity plane — admin console
            <Badge variant="secondary">phase 1 · read-only</Badge>
          </h1>
          <SectionNote className="mt-1">
            The OIDC client inventory, the consent log and the login audit, read
            through one read model. Every endpoint here is a GET: the service
            has no write endpoint in this phase and answers 405 to anything
            else, so nothing on this page can change a client, a scope or a
            session.
          </SectionNote>
          <CallerLine />
        </div>
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            reads are audited; the audit row is logged, not persisted yet
          </span>
        </div>
      </header>

      <div
        className={cn(
          "mt-4 rounded-xl border px-4 py-3",
          staged
            ? "border-amber-500/60 bg-amber-500/10"
            : "border-border/70 bg-card/40",
        )}
        data-testid={staged ? "staged-data-banner" : "live-data-banner"}
      >
        <div className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className="font-semibold">
            {staged ? "STAGED DATA — this is not the live IdP" : "Live source"}
          </span>
          <Monospace>{source.description}</Monospace>
        </div>
        {source.fixture ? (
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {source.fixture.captureNote}
          </p>
        ) : (
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            Every read below goes to the gateway through this app's existing
            credential helper. Today that means a refusal: the live process
            admits nobody and the endpoints are not mounted yet, so each panel
            shows the specific reason instead of an empty table. Open this page
            with <Monospace>?fixture={STAGED_FIXTURE_IDS[0]}</Monospace> to read
            a recorded capture instead.
          </p>
        )}
      </div>

      <nav
        aria-label="Console sections"
        className="mt-4 flex flex-wrap gap-1 border-b border-border/60 pb-1"
        data-testid="admin-tabs"
      >
        {TABS.map((entry) => (
          <button
            aria-current={tab === entry.id ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-left text-xs transition-colors",
              tab === entry.id
                ? "bg-black/5 font-semibold text-foreground dark:bg-white/10"
                : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5",
            )}
            data-testid={`admin-tab-${entry.id}`}
            key={entry.id}
            onClick={() => setTab(entry.id)}
            type="button"
          >
            <span className="block">{entry.label}</span>
            <span className="block text-[10px] font-normal text-muted-foreground">
              {entry.hint}
            </span>
          </button>
        ))}
      </nav>

      <div className="mt-4" data-testid={`admin-tab-panel-${tab}`}>
        {tab === "clients" ? <ClientsTab source={source} /> : null}
        {tab === "consent" ? <ConsentTab source={source} /> : null}
        {tab === "audit" ? <AuditTab source={source} /> : null}
        {tab === "health" ? <HealthTab source={source} /> : null}
      </div>

      <details className="mt-6 rounded-xl border border-border/70 bg-card/40 px-4 py-3 text-xs">
        <summary className="cursor-pointer font-semibold">
          How to read this console, and what is deferred
        </summary>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            The first question asked of a consent row is whether anybody
            answered it. A row with no response timestamp is an abandoned login,
            not a refusal and not an approval.
          </li>
          <li>
            There is no single total of decisions on this page. Reading the log
            row count as one is the misreport the five-way classification exists
            to prevent.
          </li>
          <li>
            A refused read is shown as a refusal with the service's own words.
            An empty table is never used to mean "the answer never arrived".
          </li>
          <li>
            Session keys are counted, never attributed to a person: the key is
            the live cookie value, so per-user attribution is NOT BUILT and says
            so.
          </li>
          <li>
            A drift verdict for the client projection is not in this payload:
            J12's <Monospace>render-clients.py --check</Monospace> is a
            host-side command. The identity of the projection is shown instead.
          </li>
        </ul>
      </details>
    </div>
  );
}
