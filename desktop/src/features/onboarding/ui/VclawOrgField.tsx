import * as React from "react";

import { Button } from "@/shared/ui/button";

import {
  VCLAW_DEFAULT_ORG,
  VCLAW_ORG_ACCEPTED_HINT,
  validateOrgEntry,
} from "../vclawOrg";
import { ONBOARDING_LANDING_CTA_CLASS } from "./OnboardingChrome";
import { OnboardingInput } from "./OnboardingInput";

/**
 * THE ORG FIELD — one name, pre-filled with the default, and the thing that lets the sign-in go on.
 *
 * Operator requirements, 2026-10-03: "offer org selector, default is 'vclaw', and allow user to
 * specify / verify her org / segment name", and "don't list all segments available, simply offer
 * either the default 'vclaw' or a keyword (segment / org name) the user is given".
 *
 * SO THERE IS NO SELECTOR AND NO CATALOGUE: one text field, pre-filled `vclaw` (a default SHOWN, not
 * assumed from an empty field), a hint that states what is accepted BEFORE the user types, and a
 * prompt that speaks on success AND on failure (docs/UI_INPUT_VALIDATION.md). Nothing here lists,
 * suggests or autocompletes an org name — the keyword is something the user was given.
 *
 * ── WHY THE CTA LIVES INSIDE THIS COMPONENT ─────────────────────────────────────────────────────
 * The requirement is that validation GATES PROGRESS — "until the field is valid there is no next
 * step, rather than a warning beside an enabled button". A component that only reported validity
 * would leave that to each caller, and one caller would eventually render an enabled button beside
 * an invalid field. Here the button IS inside: it is disabled while the entry is invalid, and
 * `onSignIn` is called with a value that has passed the check or not at all. One field, one gate.
 *
 * The check is SHAPE (see `vclawOrg.ts`). Whether the org is GRANTED is decided by the estate's own
 * claim after the token arrives, and the prompt says so rather than implying this field knows.
 */
export type VclawOrgFieldProps = {
  /** Called with the entry ONLY when it is valid. Never called with an invalid one. */
  onSignIn: (org: string) => void;
  /** True while the IdP trip is in flight; the CTA stays disabled and says so. */
  pending: boolean;
  /** Each screen keeps its own handle on the CTA (`welcome-vclaw-sign-in`, ...). */
  ctaTestId?: string;
  /** Result lines: the estate's answer, or the reason the sign-in stopped. */
  children?: React.ReactNode;
};

export function VclawOrgField({
  onSignIn,
  pending,
  ctaTestId = "vclaw-org-sign-in",
  children,
}: VclawOrgFieldProps) {
  const [value, setValue] = React.useState(VCLAW_DEFAULT_ORG);
  const validation = React.useMemo(() => validateOrgEntry(value), [value]);
  const inputId = React.useId();
  const promptId = `${inputId}-prompt`;
  const hintId = `${inputId}-hint`;

  return (
    <div
      className="flex w-full max-w-md flex-col items-stretch gap-3 text-left"
      data-testid="vclaw-org-field"
    >
      <label
        className="text-xs font-medium text-foreground/80"
        htmlFor={inputId}
      >
        Org
      </label>
      <OnboardingInput
        aria-describedby={`${promptId} ${hintId}`}
        aria-invalid={validation.ok ? undefined : true}
        autoComplete="off"
        data-testid="vclaw-org-input"
        id={inputId}
        onChange={(event) => setValue(event.target.value)}
        spellCheck={false}
        value={value}
      />
      {/* THE PROMPT: what was taken, or what is wrong and what would be right. One element, so a
          screen reader and a reader of the rendered DOM see the same single answer. */}
      <p
        className={
          validation.ok
            ? "text-xs leading-5 text-muted-foreground"
            : "text-xs leading-5 text-destructive"
        }
        data-status={validation.ok ? "ok" : "invalid"}
        data-testid="vclaw-org-prompt"
        id={promptId}
        role={validation.ok ? "status" : "alert"}
      >
        {validation.message}
      </p>
      <p className="text-xs leading-5 text-muted-foreground" id={hintId}>
        {VCLAW_ORG_ACCEPTED_HINT}
      </p>
      <Button
        className={ONBOARDING_LANDING_CTA_CLASS}
        data-testid={ctaTestId}
        disabled={pending || !validation.ok}
        onClick={() => {
          // Belt AND braces: the button is disabled while the entry is invalid, and the handler
          // refuses to advance anyway. A disabled attribute is a rendering detail; this is the gate.
          if (!validation.ok) return;
          onSignIn(validation.entry.trimmed);
        }}
        type="button"
      >
        {pending ? "Opening vclaw login…" : "Login with VClaw"}
      </Button>
      {children}
    </div>
  );
}
