/**
 * THE SHADOW-MODE BANNER, and the only place this feature explains what an
 * "allow" means.
 *
 * Why it is a banner and not a footnote: `allows_are_enforcement` is false
 * whenever the mode is shadow (design §6.1: the gateway's authorization function
 * boots in `shadow` and returns the LEGACY outcome), so every row this feature
 * might render — a client, a diff, an invariant — could be read as a statement
 * about enforcement when it is not one. §8 makes this concrete: the console must
 * print the shadow sentence **above** every table it shows. This component is
 * therefore rendered ABOVE the panels, never inside one.
 *
 * What it will not do:
 *   - it does not read `allows_are_enforcement` off the payload; `describeEnforcement`
 *     derives it from `available` and `mode`, and a payload that disagrees with
 *     its own fields has that disagreement printed, not swallowed;
 *   - it does not print a number for the deny-until-TTL set while that set has no
 *     HTTP surface: "0 revocations" is a claim nobody made (§6.2);
 *   - it does not render "shadow" for an unknown mode. Unknown is its own answer.
 *
 * PURE: props in, markup out. No fetch, no state, no effect.
 */

import { EyeOff, ShieldAlert, ShieldCheck } from "lucide-react";

import { Monospace, SectionNote } from "../../admin/ui/idp-bits";
import {
  describeDenyUntilTTL,
  describeEnforcement,
} from "../phase2-enforcement";
import type { EnforcementState } from "../phase2-types";

export function EnforcementBanner({
  state,
}: {
  /** The `enforcement` object of `GET /api/idp/changes`, or `null` when absent. */
  state: EnforcementState | null;
}) {
  const view = describeEnforcement(state);
  const deny = describeDenyUntilTTL(state);
  const Icon = view.allowsAreEnforcement
    ? ShieldCheck
    : view.shadowMode
      ? EyeOff
      : ShieldAlert;
  const tone = view.allowsAreEnforcement
    ? "border-emerald-500/50 bg-emerald-500/5"
    : "border-amber-500/50 bg-amber-500/5";

  return (
    <section
      aria-label="Authorization enforcement mode"
      className={`rounded-xl border p-4 ${tone}`}
      data-allows-are-enforcement={String(view.allowsAreEnforcement)}
      data-mode={view.mode === "" ? "unknown" : view.mode}
      data-shadow-mode={String(view.shadowMode)}
      data-testid="phase2-enforcement-banner"
      role="status"
    >
      <div className="flex items-start gap-3">
        <Icon
          className={
            view.allowsAreEnforcement
              ? "mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
              : "mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          }
        />
        <div className="min-w-0 flex-1">
          <h2
            className="text-sm font-semibold"
            data-testid="phase2-enforcement-headline"
          >
            {view.headline}
          </h2>
          <SectionNote className="mt-1">{view.detail}</SectionNote>
          {view.payloadDisagrees ? (
            <p
              className="mt-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11px] leading-4 text-muted-foreground"
              data-testid="phase2-enforcement-disagreement"
            >
              This payload reported{" "}
              <Monospace>
                allows_are_enforcement:{" "}
                {String(state?.allows_are_enforcement ?? "absent")}
              </Monospace>{" "}
              while its own mode is{" "}
              <Monospace>
                {view.mode === "" ? "unrecognised" : view.mode}
              </Monospace>
              . This console derives the field from the mode and renders the
              derived value above; the copy it was sent is not used.
            </p>
          ) : null}
          <p
            className="mt-2 text-[11px] leading-4 text-muted-foreground"
            data-testid="phase2-deny-until-ttl"
          >
            <span className="font-medium text-foreground">
              deny-until-TTL:{" "}
            </span>
            {deny.available ? (
              <>
                {deny.entries === null
                  ? "count not reported"
                  : `${deny.entries} entries`}
                . {deny.sentence}
              </>
            ) : (
              <>not available, and not zero. {deny.sentence}</>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
