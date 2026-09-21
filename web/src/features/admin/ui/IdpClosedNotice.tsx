/**
 * THE FAIL-CLOSED NOTICE — what the console shows when a read is refused.
 *
 * This is the acceptance-critical component of phase 1. The live gateway runs
 * with a nil admission function (`internal/api/auth_nip98.go:129`) and the
 * endpoints are not mounted yet, so EVERY `/api/idp/*` read is refused today:
 * 401 from admission, 501 from the gateway's unimplemented-lane fallback, or
 * HTML from a static host answering the API path. Each of those is a different
 * fact and gets its own sentence.
 *
 * What this component must NEVER do, and does not:
 *   - keep a spinner running (the read has a deadline; a failure is a failure);
 *   - render an empty table, which reads as "no data" when the truth is "no answer";
 *   - render a zero for a number that was never returned;
 *   - paraphrase the service. The server's own sentence is quoted verbatim,
 *     including the `restricted:` prefix, so the gateway's error vocabulary
 *     reaches a human and any classifier that keys on it keeps working.
 */

import { KeyRound, PlugZap, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/shared/ui/button";
import type { IdpFailure, IdpFailureKind } from "../idp-source";
import { Monospace } from "./idp-bits";

/** Per-kind subordinate line: what to do, or what the state would look like if it changed. */
const NEXT_STEP: Record<IdpFailureKind, string> = {
  not_authorized:
    "Nothing was returned and nothing was withheld: the caller was refused at the door. This is the expected state until a principal registry exists.",
  restricted:
    "Nothing was returned. Ask the operator to add the client to an organization you belong to, or to give you the admin group for it.",
  not_found:
    "Nothing was returned. The grant log can still hold rows for this client; open the consent view and look for its client id.",
  not_mounted:
    'The endpoint exists in the read model but is not serving here. A 501 is the gateway\'s own "not implemented" answer; a web page in place of JSON means a static host answered the API path. Either way, "surface not mounted" is not "no data".',
  unavailable:
    "The endpoint answered and refused — a 503, not an empty result. The detail above is the service's reason, and the health view shows the same state without the refusal.",
  bad_request:
    "Nothing was returned. This console builds its own filters, so a rejected one is a defect worth reporting with the path shown above.",
  no_credential:
    "Nothing was sent. The console signs its reads with the app's existing credential helper; a failure there is shown rather than worked around.",
  unreachable:
    "Nothing was returned. Check that the gateway is up and reachable from this browser, then try again.",
  unexpected:
    "Nothing was interpreted. The raw reply is quoted above so it can be read as what it is.",
};

const KIND_ICON: Partial<Record<IdpFailureKind, typeof KeyRound>> = {
  not_authorized: KeyRound,
  restricted: KeyRound,
  not_mounted: PlugZap,
  unreachable: PlugZap,
};

export function IdpClosedNotice({
  failure,
  onRetry,
}: {
  failure: IdpFailure;
  onRetry?: () => void;
}) {
  const Icon = KIND_ICON[failure.kind] ?? TriangleAlert;
  const isRestricted = failure.evidence.includes("restricted:");
  return (
    <div
      className="rounded-xl border border-amber-500/50 bg-amber-500/5 p-4"
      data-testid="idp-closed-notice"
      data-kind={failure.kind}
      data-status={failure.status ?? "none"}
      role="status"
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold" data-testid="idp-closed-title">
            {failure.title}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {failure.meaning}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {NEXT_STEP[failure.kind]}
          </p>
          <dl className="mt-3 space-y-1 text-xs">
            {failure.path ? (
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="text-muted-foreground">read attempted</dt>
                <dd>
                  <Monospace>{failure.path}</Monospace>
                </dd>
              </div>
            ) : null}
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-muted-foreground">what the service said</dt>
              <dd>
                <span data-testid="idp-closed-evidence">
                  <Monospace>{failure.evidence || "nothing"}</Monospace>
                </span>
              </dd>
            </div>
          </dl>
          {isRestricted ? (
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              The server's <Monospace>restricted:</Monospace> vocabulary is
              quoted unchanged, on purpose: this app classifies denials by that
              prefix.
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {onRetry ? (
              <Button
                data-testid="idp-closed-retry"
                onClick={onRetry}
                size="sm"
                variant="outline"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try this read again
              </Button>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              A refused read is not a zero and not an empty list.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
