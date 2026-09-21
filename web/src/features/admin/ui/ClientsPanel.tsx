/**
 * THE OIDC CLIENT INVENTORY, with what drift state can honestly be shown.
 *
 * TWO DIFFERENT THINGS, kept apart on purpose:
 *
 *  1. THE PROJECTION'S IDENTITY. The payload carries which file answered, its
 *     content hash, the version, the generator, the hash of the source
 *     configuration it was rendered from, and that configuration's size. That is
 *     what identifies the inventory, and it is what a reader needs in order to
 *     know whether the file they are looking at is the one they think.
 *
 *  2. A DRIFT VERDICT — whether the loaded projection still matches the live
 *     configuration byte for byte. That is NOT in this payload. J12's drift
 *     oracle is the host-side `render-clients.py --check`, which is a command,
 *     not an endpoint (`.prime/handoff/idp-build/j12/render-clients.py`, exit 10
 *     = drift), and this console does not invent one. The line below says so
 *     rather than showing a green tick nobody earned.
 *
 * What CAN be checked from two payloads this console already has is a real,
 * useful cross-check: which client ids appear in the grant log, which of those
 * are absent from the inventory (a retired client still holding session rows —
 * MEASURED: `oclaw-app` holds 5 rows and is absent from the live configuration),
 * and which inventory clients have never been used.
 *
 * SECRETS: `has_client_secret` is a BOOLEAN and the payload has no field for a
 * value, so this panel prints "stored" or "none". There is deliberately no
 * masked placeholder anywhere: a placeholder implies a value exists.
 */

import { ShieldQuestion } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { toIdpFailure, type IdpSource } from "../idp-source";
import type { IdpClientsResponse } from "../idp-types";
import { useIdpConsentSummary } from "../use-idp-admin";
import { IdpClosedNotice } from "./IdpClosedNotice";
import {
  Absent,
  Chip,
  Kv,
  Monospace,
  NumberCard,
  SectionNote,
} from "./idp-bits";

function shortSha(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 16)}…` : sha;
}

function PkceCell({
  pkce,
}: {
  pkce: IdpClientsResponse["clients"][number]["pkce"];
}) {
  if (pkce.declared) {
    return (
      <span>
        {pkce.required ? "required" : "not required"}
        {pkce.challenge_method ? ` (${pkce.challenge_method})` : ""}{" "}
        <span className="text-muted-foreground">— declared on the client</span>
      </span>
    );
  }
  return (
    <span>
      {pkce.required ? "required" : "not required"}{" "}
      <span className="text-muted-foreground">
        — not declared on the client; this is the provider default
        {pkce.note ? ` (${pkce.note})` : ""}
      </span>
    </span>
  );
}

export function ClientsPanel({
  data,
  source,
}: {
  data: IdpClientsResponse;
  source: IdpSource;
}) {
  const summary = useIdpConsentSummary(source);
  const inventoryIds = new Set(data.clients.map((client) => client.client_id));
  const logIds = (summary.data?.by_client ?? []).map((group) => group.key);
  const inLogNotInInventory = logIds.filter((id) => !inventoryIds.has(id));
  const inInventoryNotInLog = [...inventoryIds].filter(
    (id) => !logIds.includes(id),
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <NumberCard
          label="clients in the projection"
          value={data.counts.total ?? data.clients.length}
          note="the whole inventory this service loaded, before any scope filter"
          testId="clients-total"
        />
        <NumberCard
          label="visible to this caller"
          value={data.counts.visible ?? data.clients.length}
          note="scoped by the clients owned by the caller's organizations, resolved per request"
          testId="clients-visible"
        />
        <NumberCard
          label="outside this caller's scope"
          value={data.counts.out_of_scope ?? 0}
          note="reported as a count only: out-of-scope clients are never listed"
          testId="clients-out-of-scope"
        />
        <NumberCard
          label="owned by an organization"
          value={data.counts.owned ?? 0}
          note="ownership comes from the registry this service owns, never from a token claim"
          testId="clients-owned"
        />
        <NumberCard
          label="unowned"
          value={data.counts.visible_unowned ?? 0}
          note="an unowned client is reachable only by a global admin — the fail-closed default"
          testId="clients-unowned"
        />
        <NumberCard
          label="read at"
          value={data.as_of}
          note="the projection's identity is shown below; a drift verdict is not in this payload"
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold">Which projection answered</h3>
        <SectionNote className="mt-0.5">
          The inventory is rendered from a non-secret projection of the live
          configuration, because the live file also holds inline client secrets
          and this service does not read it.
        </SectionNote>
        <div className="mt-2 rounded-lg border border-border/70 bg-card/40 px-3 py-2">
          <Kv label="projection file" mono>
            {data.source.path}
          </Kv>
          <Kv label="projection sha256" mono>
            {data.source.sha256}{" "}
            <span className="text-muted-foreground">
              ({shortSha(data.source.sha256)})
            </span>
          </Kv>
          <Kv label="projection version">{data.source.projection_version}</Kv>
          <Kv label="generated by" mono>
            {data.source.generated_by}
          </Kv>
          <Kv label="source config sha256" mono>
            {data.source.source_config_sha256} (
            {data.source.source_config_bytes} bytes)
          </Kv>
          <div
            className="mt-2 flex items-start gap-2 rounded-md border border-dashed border-border/70 px-2 py-2"
            data-testid="clients-drift-verdict"
          >
            <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <p className="text-[11px] leading-4 text-muted-foreground">
              <span className="font-medium">
                Drift verdict: not in this payload.
              </span>{" "}
              Whether the loaded projection still matches the live configuration
              is decided by J12's{" "}
              <Monospace>render-clients.py --check</Monospace> on the host (exit
              10 = drift). There is no endpoint for it, so this panel reports
              the projection's identity and does not claim a verdict it cannot
              make. The cross-check below is a different question, and it is one
              this console can answer from two payloads.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold">
          Cross-check: the inventory against the grant log
        </h3>
        {summary.isError ? (
          <>
            <SectionNote className="mt-0.5">
              This cross-check needs the counts-only consent view. It is refused
              here, so nothing is being claimed about which clients hold rows.
            </SectionNote>
            <div className="mt-2">
              <IdpClosedNotice
                failure={toIdpFailure(summary.error)}
                onRetry={() => void summary.refetch()}
              />
            </div>
          </>
        ) : summary.isPending ? (
          <SectionNote className="mt-0.5">
            Reading the counts-only consent view to compare its client list…
          </SectionNote>
        ) : (
          <>
            <SectionNote className="mt-0.5">
              Computed here by comparing the two payloads. It is a browser-side
              check, not a verdict from the service.
            </SectionNote>
            <ul className="mt-2 space-y-1 text-xs">
              <li data-testid="clients-in-log-not-inventory">
                client ids in the log but absent from the inventory:{" "}
                {inLogNotInInventory.length === 0 ? (
                  <span className="text-muted-foreground">none</span>
                ) : (
                  inLogNotInInventory.map((id) => (
                    <Chip
                      key={id}
                      tone="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    >
                      {id}
                    </Chip>
                  ))
                )}
                {inLogNotInInventory.length > 0 ? (
                  <div className="mt-0.5 text-muted-foreground">
                    These hold rows in the grant log and cannot be administered
                    as clients: the client id is no longer in the live
                    configuration. Their rows remain, and their sessions are
                    part of the session count.
                  </div>
                ) : null}
              </li>
              <li data-testid="clients-inventory-not-in-log">
                inventory clients with no row in the log:{" "}
                {inInventoryNotInLog.length === 0 ? (
                  <span className="text-muted-foreground">none</span>
                ) : (
                  inInventoryNotInLog.map((id) => <Chip key={id}>{id}</Chip>)
                )}
              </li>
            </ul>
          </>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold">Clients</h3>
        <SectionNote className="mt-0.5">
          Every column here is a field the payload contains. A redirect target
          is reduced to its HOST by the service: the question an administrator
          asks is which host may receive a code, and a full URI list is a wider
          surface than that question needs.
        </SectionNote>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[72rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">client</th>
                <th className="py-1.5 pr-3 font-medium">owner</th>
                <th className="py-1.5 pr-3 font-medium">kind</th>
                <th className="py-1.5 pr-3 font-medium">PKCE</th>
                <th className="py-1.5 pr-3 font-medium">approval mode</th>
                <th className="py-1.5 pr-3 font-medium">token auth</th>
                <th className="py-1.5 pr-3 font-medium">client secret</th>
                <th className="py-1.5 pr-3 font-medium">redirect hosts</th>
                <th className="py-1.5 pr-3 font-medium">scopes</th>
                <th className="py-1.5 pr-3 font-medium">grant types</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.length === 0 ? (
                <tr>
                  <td className="py-3 text-muted-foreground" colSpan={10}>
                    The service returned no clients for this caller. That is a
                    legitimate answer for a caller in no organization — the
                    inventory above still reports how many exist, so this is a
                    scoped view and not an empty estate.
                  </td>
                </tr>
              ) : null}
              {data.clients.map((client) => (
                <tr
                  key={client.client_id}
                  className="border-b border-border/40 align-top"
                  data-testid={`client-row-${client.client_id}`}
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium">{client.client_name}</div>
                    <Monospace>{client.client_id}</Monospace>
                  </td>
                  <td className="py-2 pr-3">
                    {client.owned ? (
                      <Chip tone="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                        {client.org}
                      </Chip>
                    ) : (
                      <Chip tone="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                        unowned
                      </Chip>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {client.public ? "public" : "confidential"}
                  </td>
                  <td className="max-w-[18rem] py-2 pr-3">
                    <PkceCell pkce={client.pkce} />
                  </td>
                  <td className="py-2 pr-3">{client.consent_mode}</td>
                  <td className="py-2 pr-3">
                    <Monospace>{client.token_endpoint_auth_method}</Monospace>
                  </td>
                  <td className="py-2 pr-3">
                    {client.has_client_secret ? (
                      <span>stored (the value is not in the payload)</span>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {client.redirect_uri_hosts.length === 0 ? (
                      <Absent reason="no redirect host is registered for this client" />
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {client.redirect_uri_hosts.map((host) => (
                          <Chip key={host} className="font-mono">
                            {host}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {client.scopes.join(" ")}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {client.grant_types.join(" ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SectionNote className={cn("mt-2", "text-muted-foreground")}>
          {data.org_scope.note}
        </SectionNote>
      </div>
    </div>
  );
}
