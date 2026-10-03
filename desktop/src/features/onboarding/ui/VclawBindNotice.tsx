import type { VclawBindReport } from "@/shared/api/vclawPrincipalBind";
import { Button } from "@/shared/ui/button";

import { describeVclawBindState } from "../lib/vclawBindCopy";
import { ONBOARDING_LANDING_CTA_CLASS } from "./OnboardingChrome";

/**
 * THE FAILED DEVICE BINDING, SAID OUT LOUD (plan `docs/AUTH_BIND_PLAN.md` jobs A2 and A4).
 *
 * It renders NOTHING for `bound`: a success is not an error surface, and a component that returned a
 * green tick here would be a second thing to keep true.
 *
 * ⚠ THIS IS WHY THE SIGN-IN STOPS. The alternative — enter the shell anyway — is the defect A2 names:
 * an app with no agents and no error is indistinguishable from an estate with nothing in it, and the
 * person has no way to tell a failed bind from an empty account. So the sign-in sequence refuses to
 * complete while this notice is on the screen, and the retry is the way forward.
 *
 * The `data-state` attribute is the state itself, not a rendering hint: T3/T6 and the unit suite
 * assert the STATES are distinct, so "there is some error" is not an assertion anyone can make here
 * by accident. The backend's reason is rendered as `data-reason` (a short code) and deliberately
 * never interpolated into the prose a person reads — see `vclawBindCopy.ts`.
 */
export function VclawBindNotice({
  report,
  onRetry,
  pending,
  testId = "vclaw-bind-notice",
  retryTestId = "vclaw-bind-retry",
}: {
  report: VclawBindReport | null;
  onRetry: () => void;
  /** True while a retry is in flight; the control stays disabled and says so. */
  pending: boolean;
  testId?: string;
  retryTestId?: string;
}) {
  if (!report || report.state === "bound") return null;
  const copy = describeVclawBindState(report.state);
  return (
    <div
      className="flex w-full flex-col items-stretch gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-left"
      data-reason={report.reason ?? ""}
      data-state={report.state}
      data-testid={testId}
      role="alert"
    >
      <p
        className="text-sm font-medium text-destructive"
        data-testid={`${testId}-title`}
      >
        {copy.title}
      </p>
      <p
        className="text-xs leading-5 text-destructive"
        data-testid={`${testId}-body`}
      >
        {copy.body}
      </p>
      <Button
        className={`${ONBOARDING_LANDING_CTA_CLASS} mt-1 self-start px-5`}
        data-testid={retryTestId}
        disabled={pending}
        onClick={onRetry}
        type="button"
      >
        {pending ? "Trying again…" : copy.retryLabel}
      </Button>
    </div>
  );
}
