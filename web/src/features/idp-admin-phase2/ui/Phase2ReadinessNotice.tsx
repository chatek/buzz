/**
 * WHAT THE READINESS PROBE FOUND, in one line an operator can act on.
 *
 * The state comes from `phase2-readiness.ts` (§8 of the design); this component
 * only decides how to say it, and its sentences are the same four sentences the
 * state machine returns. It exists as its own file because the difference it has
 * to make visible is easy to erase in a panel header:
 *
 *   501 -> the route does not exist      -> "not deployed"
 *   401 -> the route exists, refuses all -> "deployed and nobody can use it yet"
 *
 * Both look like "nothing works". They are not the same fact, and only one of
 * them is worth an operator's time (design §8).
 *
 * The probe's own evidence is quoted verbatim underneath, including the
 * `restricted:` prefix the gateway's vocabulary uses, so a reader can tell a 501
 * from a 401 from an HTML page without trusting this component's summary.
 *
 * PURE: props in, markup out. No fetch, no state, no effect.
 */

import { CircleCheck, KeyRound, PlugZap, TriangleAlert } from "lucide-react";

import { Monospace, SectionNote } from "../../admin/ui/idp-bits";
import {
  type Phase2Probe,
  type Phase2Readiness,
  probeEvidence,
  readinessReason,
} from "../phase2-readiness";

/** The consequence of each state, which is the part an operator acts on. */
const CONSEQUENCE: Record<Phase2Readiness, string> = {
  absent:
    "No write control is rendered below this notice. A 501 is the gateway's own answer for a route that does not exist, so a control here would call nothing; a button that calls a non-existent route is worse than no button.",
  mounted_closed:
    "The controls below are rendered and every one of them is disabled. The surface exists and refuses every caller, which is a deployment state worth seeing and not the same fact as 'not mounted'.",
  ready:
    "The change log answered, so the surface is mounted and this caller is resolved. A control is still enabled only where its own precondition holds: a create, a modify and an apply each also need an open maintenance window.",
  unknown:
    "Treated as absent: no control is rendered, and nothing is claimed about whether the surface is mounted. An answer this console cannot classify is not evidence of a working endpoint.",
};

const ICON: Record<Phase2Readiness, typeof PlugZap> = {
  absent: PlugZap,
  mounted_closed: KeyRound,
  ready: CircleCheck,
  unknown: TriangleAlert,
};

export function Phase2ReadinessNotice({
  readiness,
  probe,
}: {
  readiness: Phase2Readiness;
  /** The probe that produced the state, when there is one. Its evidence is quoted, not summarized. */
  probe?: Phase2Probe;
}) {
  const Icon = ICON[readiness];
  const calm = readiness === "ready";
  return (
    <section
      aria-label="Phase 2 surface readiness"
      className={
        calm
          ? "rounded-xl border border-emerald-500/50 bg-emerald-500/5 p-4"
          : "rounded-xl border border-amber-500/50 bg-amber-500/5 p-4"
      }
      data-readiness={readiness}
      data-testid="phase2-readiness-notice"
      role="status"
    >
      <div className="flex items-start gap-3">
        <Icon
          className={
            calm
              ? "mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
              : "mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          }
        />
        <div className="min-w-0 flex-1">
          <h2
            className="text-sm font-semibold"
            data-testid="phase2-readiness-line"
          >
            {readinessReason(readiness)}
          </h2>
          <SectionNote className="mt-1">{CONSEQUENCE[readiness]}</SectionNote>
          {probe ? (
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              the probe read{" "}
              <Monospace>{probe.path ?? "/api/idp/changes"}</Monospace> and saw{" "}
              <span data-testid="phase2-readiness-evidence">
                <Monospace>{probeEvidence(probe)}</Monospace>
              </span>
            </p>
          ) : (
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              no probe result was passed in, so this notice reports the state it
              was given and no evidence.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
