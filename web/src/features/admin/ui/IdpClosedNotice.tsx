/**
 * THE FAIL-CLOSED NOTICE — what the console shows when a read is refused.
 *
 * This is the acceptance-critical component of phase 1. WHAT IS OBSERVED TODAY,
 * and it is an observation with a date rather than a description of the
 * mechanism: MEASURED 2026-09-22, the route serves and EVERY `/api/idp/*` read is
 * refused AT ADMISSION with `401 restricted: missing Authorization` — including a
 * path that does not exist, which shows the whole subtree is guarded before the
 * dispatcher is reached. No read reaches the read model.
 *
 * The three refusal shapes this component must handle are therefore: 401 at
 * admission (the state above), 501 if nothing is mounted at the path (the
 * gateway's own unimplemented-lane answer), and HTML in place of JSON when a
 * static host answers the API path. Each is a different fact and gets its own
 * sentence.
 *
 * HISTORY, DATED AND IN THE PAST TENSE, not a claim about now: until 2026-09-22
 * this file said "the endpoints are not mounted yet". As of 2026-09-22 the
 * endpoints ARE mounted and refuse at admission. The 501 branch stays because
 * "nothing is mounted at this path" remains a state any deployment can be in
 * again — it is a branch, not a description of today.
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
import {
  FAILURE_SURFACE,
  type IdpFailure,
  type IdpFailureKind,
} from "../idp-source";
import { Monospace } from "./idp-bits";

/**
 * WHICH ICON THE NOTICE DRAWS — an exhaustive `Record<IdpFailureKind, …>` as well,
 * so a new kind must be given an icon or `tsc` fails. The notice's WORDS all come
 * from `FAILURE_SURFACE` in `idp-source.ts`, the same table the header reads, which
 * is what makes "the same event, two surfaces, contradictory" impossible to build.
 */
const KIND_ICON: Record<IdpFailureKind, typeof KeyRound> = {
  not_authorized: KeyRound,
  restricted: KeyRound,
  no_credential: KeyRound,
  not_mounted: PlugZap,
  unavailable: PlugZap,
  unreachable: PlugZap,
  not_found: TriangleAlert,
  bad_fixture: TriangleAlert,
  bad_request: TriangleAlert,
  unexpected: TriangleAlert,
};

export function IdpClosedNotice({
  failure,
  onRetry,
}: {
  failure: IdpFailure;
  onRetry?: () => void;
}) {
  const copy = FAILURE_SURFACE[failure.kind];
  const Icon = KIND_ICON[failure.kind];
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
            {copy.title}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {copy.meaning}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {copy.nextStep}
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
