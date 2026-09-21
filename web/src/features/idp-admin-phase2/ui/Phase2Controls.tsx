/**
 * THE FOUR PHASE-2 CONTROLS — absent, or disabled with a reason. Never active.
 *
 * The three rules this component exists to keep (design §8):
 *
 *  1. `absent` and `unknown` render NOTHING. A disabled button still asserts that
 *     the route exists; when the probe could not say so, the honest render is no
 *     control at all.
 *  2. A visible control is `disabled` with its reason written out beside it, not
 *     hidden in a tooltip. The reason for a closed window is the SERVER'S OWN
 *     sentence ("no maintenance window is open", §4.4), so the console and the
 *     eventual 409 use the same words.
 *  3. A control may be enabled only when readiness is `ready` AND its own
 *     precondition holds. That rule is ONE function (`phase2ControlState`), not
 *     four inline conditions, so "why is this button dead" has one answer.
 *
 * WHAT THIS FILE MUST NEVER DO, and does not: it renders no `<form>`, performs no
 * fetch, and wires no `onClick`. There is nothing here that posts. Phase 2 is
 * staged: the surface is not mounted on any deployment yet, and a control that
 * looks live while calling nothing is worse than a disabled one.
 */

import { Button } from "@/shared/ui/button";
import { Monospace, SectionNote } from "../../admin/ui/idp-bits";
import { IDEMPOTENCY_HEADER } from "../phase2-paths";
import {
  PHASE2_CONTROLS,
  type Phase2Readiness,
  phase2ControlState,
} from "../phase2-readiness";

/**
 * Phase 2 ships staged. Nothing in this directory calls an endpoint, so no
 * control is active. `phase2ControlState` stays the single gate a future wiring
 * must satisfy — it answers `enabled` only when readiness is `ready` and the
 * window precondition holds — and this flag is the single place to revisit when a
 * handler exists. Flipping it alone would enable nothing: there is still no
 * `onClick` to run.
 */
const PHASE2_UI_IS_STAGED = true;

/** Why an otherwise-allowed control is still not active in this build. */
const STAGED_REASON =
  "this build has no action wired to this control: no handler, no form and no request, so it cannot be enabled here even where the gate above would allow it";

export function Phase2Controls({
  readiness,
  windowOpen = false,
}: {
  readiness: Phase2Readiness;
  /** `window.open` from `GET /api/idp/changes`. Defaults to closed: closed is the default state (§4.3). */
  windowOpen?: boolean;
}) {
  const rendered = PHASE2_CONTROLS.map((control) => ({
    control,
    view: phase2ControlState(control, readiness, windowOpen),
  })).filter(({ view }) => view.visible);

  // `absent` and `unknown`: the probe could not even say the route exists.
  if (rendered.length === 0) return null;

  return (
    <section
      aria-label="Phase 2 write controls"
      className="space-y-2"
      data-readiness={readiness}
      data-testid="phase2-controls"
    >
      {rendered.map(({ control, view }) => {
        const active = !PHASE2_UI_IS_STAGED && view.enabled;
        const reason = active
          ? ""
          : view.reason === ""
            ? STAGED_REASON
            : view.reason;
        return (
          <div
            className="rounded-lg border border-border/70 bg-card/40 px-3 py-2"
            data-control={control.id}
            data-enabled={String(active)}
            data-testid={`phase2-control-${control.id}`}
            key={control.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{control.label}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  <Monospace>
                    {control.method} {control.template}
                  </Monospace>
                  {control.needsIdempotencyKey ? (
                    <>
                      {" "}
                      requires <Monospace>{IDEMPOTENCY_HEADER}</Monospace>
                    </>
                  ) : (
                    <> no idempotency key: a read repeats safely</>
                  )}
                </div>
              </div>
              <Button
                aria-disabled={!active}
                data-testid={`phase2-control-button-${control.id}`}
                disabled
                size="sm"
                title={reason}
                type="button"
                variant="outline"
              >
                {control.label}
              </Button>
            </div>
            <SectionNote className="mt-1">{control.summary}</SectionNote>
            <p
              className="mt-1 text-xs leading-4 text-amber-800 dark:text-amber-200"
              data-testid={`phase2-control-reason-${control.id}`}
            >
              {reason}
            </p>
          </div>
        );
      })}
    </section>
  );
}
