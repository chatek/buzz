/**
 * THE FIVE-WAY CLASSIFICATION, as the screen must present it.
 *
 * WHY THIS SCREEN EXISTS. `oauth2_consent_session` is a grant log, not a consent
 * record (`buzz-gateway/internal/admin/classify.go`). Two of its columns look
 * like a decision and are not one:
 *
 *  - `authorized = false` is written HARDCODED by the IdP's implicit approval
 *    mode, after the flow already granted the scopes. It means "no human was
 *    asked", not "the human said no".
 *  - `responded_at IS NULL` means the screen was shown and never answered. The
 *    row exists because the flow wrote it when the screen appeared.
 *
 * So `responded_at` is the FIRST discriminator, and a row is classified on
 * (responded?, authorized, granted), in that order. A view that starts from
 * `authorized` folds 46 abandoned logins into "refused" and 130 automatic
 * admissions into "approved". That is the misreport this feature exists to
 * prevent, and the rule below is what prevents it: THERE IS NO SINGLE
 * "consents" NUMBER ANYWHERE. Each population is named, counted and explained
 * separately, and the count of real user answers is computed as
 * approved + partial + refused — never as the row total.
 *
 * The labels of record are the server's (`states[].label`, `state_label` on a
 * row). The headings and guidance here are the operator-facing layer on top:
 * they say what to DO about a number, which the wire labels do not.
 */

import type {
  IdpConsentPopulations,
  IdpConsentState,
  IdpCountMap,
  IdpStateCount,
} from "./idp-types";

/** `LegalStates()` from classify.go: the four decisions, then the two non-answers. */
export const CONSENT_STATE_ORDER: IdpConsentState[] = [
  "approved",
  "partial",
  "refused",
  "auto_admitted",
  "pending",
  "inconsistent",
];

/**
 * `AnsweredStates()` from classify.go: the populations that carry a recorded
 * user answer. `auto_admitted` is deliberately NOT here even though it has a
 * `responded_at`: a timestamp was written, no human was asked.
 */
export const ANSWERED_STATES: IdpConsentState[] = [
  "approved",
  "partial",
  "refused",
];

export type StatePresentation = {
  state: IdpConsentState;
  /** Short heading for a non-engineer. */
  heading: string;
  /** What the number means and what to do about it. */
  guidance: string;
  /** true only for the three states a human decided. */
  answered: boolean;
  /** Chip classes. */
  tone: string;
};

export const CONSENT_STATE_PRESENTATION: Record<
  IdpConsentState,
  StatePresentation
> = {
  approved: {
    state: "approved",
    heading: "Approved by the user",
    guidance:
      "The user answered and allowed every scope the client requested. Nothing to do.",
    answered: true,
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  partial: {
    state: "partial",
    heading: "Answered, some scopes unchecked",
    guidance:
      "The user answered and left at least one requested scope unchecked. Open the row and compare requested with granted before assuming the client received what it asked for.",
    answered: true,
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  refused: {
    state: "refused",
    heading: "Refused by the user",
    guidance:
      "The user answered and allowed nothing. This is the only state that counts as a refusal.",
    answered: true,
    tone: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  auto_admitted: {
    state: "auto_admitted",
    heading: "Auto-admitted, no one was asked",
    guidance:
      "The IdP's implicit approval mode admitted the client without showing a screen to anybody. There is no decision behind this row: it is not an approval, and it is not evidence that a human agreed to anything.",
    answered: false,
    tone: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  pending: {
    state: "pending",
    heading: "Never answered",
    guidance:
      "The screen was shown and no response was recorded, so the login was abandoned. This is not a refusal and not an approval: it is the absence of a decision, and nothing was granted to the user by it.",
    answered: false,
    tone: "border-zinc-400/50 bg-zinc-400/10 text-zinc-700 dark:text-zinc-300",
  },
  inconsistent: {
    state: "inconsistent",
    heading: "Unclassifiable, needs a look",
    guidance:
      "A decision is recorded with no response timestamp, so the row cannot be classified. The count must be zero; while it is not, the health block is not green and this population is not folded into any other.",
    answered: false,
    tone: "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
  },
};

export function isKnownState(raw: string): raw is IdpConsentState {
  return (CONSENT_STATE_ORDER as string[]).includes(raw);
}

/**
 * Presentation for a state string straight off the wire. An UNKNOWN state
 * returns null: this console shows the raw value and flags it, and never invents
 * a heading for a population it does not know.
 */
export function presentationOf(raw: string): StatePresentation | null {
  return isKnownState(raw) ? CONSENT_STATE_PRESENTATION[raw] : null;
}

export function stateCount(
  populations: IdpConsentPopulations,
  state: IdpConsentState,
): number {
  return populations[state];
}

export function populationTotal(populations: IdpConsentPopulations): number {
  return CONSENT_STATE_ORDER.reduce(
    (sum, state) => sum + populations[state],
    0,
  );
}

/** approved + partial + refused. NOT `responded`, which also counts auto-admissions. */
export function answeredCount(populations: IdpConsentPopulations): number {
  return ANSWERED_STATES.reduce((sum, state) => sum + populations[state], 0);
}

/** The `states[]` array the payload should carry, derived from the populations. */
export function populationsToStates(
  populations: IdpConsentPopulations,
  labelOf: (state: IdpConsentState) => string,
): IdpStateCount[] {
  return CONSENT_STATE_ORDER.map((state) => ({
    state,
    label: labelOf(state),
    count: populations[state],
  }));
}

// ---------------------------------------------------------------------------
// The browser-side consistency lines
//
// The server checks these as invariants on /health; the console recomputes them
// from the payload it was given, so a screenshot cannot show a set of numbers
// that do not add up without saying so. Labelled as a browser-side check, since
// it is one.
// ---------------------------------------------------------------------------

export type ConsistencyLine = {
  id: string;
  statement: string;
  ok: boolean;
  detail: string;
  /** "could not check" is a distinct state from "checked and failed". */
  unproven?: boolean;
};

export function consentConsistency(input: {
  populations: IdpConsentPopulations;
  totals?: IdpCountMap;
  states?: IdpStateCount[];
}): ConsistencyLine[] {
  const { populations, totals } = input;
  const inScope = totals?.in_scope;
  const sum = populationTotal(populations);
  const lines: ConsistencyLine[] = [
    {
      id: "populations_partition_the_rows",
      statement:
        "the six populations account for every row exactly once: none dropped, none counted twice",
      ok: inScope !== undefined && sum === inScope,
      detail:
        inScope === undefined
          ? `populations sum to ${sum}; the payload reported no in-scope total, so nothing was compared`
          : `populations sum to ${sum}, in-scope total is ${inScope}${
              sum > inScope && populations.inconsistent > 0
                ? ` — the ${populations.inconsistent} unclassifiable row(s) are counted both as never answered and as unclassifiable, which is what a defective row does to this partition`
                : ""
            }`,
      unproven: inScope === undefined,
    },
    {
      id: "answered_is_approved_partial_refused",
      statement:
        "real user answers = approved + partly approved + refused (it is not the row total)",
      ok:
        totals?.answered !== undefined &&
        answeredCount(populations) === totals.answered,
      detail:
        totals?.answered === undefined
          ? `computed ${answeredCount(populations)}; the payload reported no answered total`
          : `computed ${answeredCount(populations)}, reported ${totals.answered}`,
      unproven: totals?.answered === undefined,
    },
    {
      id: "pending_plus_responded_equals_total",
      statement:
        "rows never answered + rows with a response timestamp = every row",
      ok:
        totals?.pending !== undefined &&
        totals?.responded !== undefined &&
        inScope !== undefined &&
        totals.pending + totals.responded === inScope,
      detail:
        totals?.pending === undefined || totals?.responded === undefined
          ? "the payload did not report both a pending and a responded count"
          : `${totals.pending} + ${totals.responded} against in-scope ${
              inScope ?? "not reported"
            }`,
      unproven:
        totals?.pending === undefined ||
        totals?.responded === undefined ||
        inScope === undefined,
    },
    {
      id: "defect_bucket_is_empty",
      statement:
        "no row is unclassifiable (a decision with no response timestamp)",
      ok: populations.inconsistent === 0,
      detail: `${populations.inconsistent} unclassifiable`,
    },
  ];
  if (input.states) {
    const byState = new Map(input.states.map((s) => [s.state, s.count]));
    const mismatched = CONSENT_STATE_ORDER.filter(
      (state) =>
        (byState.get(state) ?? populations[state]) !== populations[state],
    );
    lines.push({
      id: "states_match_populations",
      statement:
        "the per-state array and the population object report the same numbers",
      ok: mismatched.length === 0,
      detail:
        mismatched.length === 0
          ? "every state agrees"
          : `disagreeing states: ${mismatched.join(", ")}`,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// THE FORBIDDEN SHAPE
//
// One regex list, used by the Playwright guard that scans the rendered page, so
// "no single consents number" is a checked property of the screen rather than a
// promise in a comment. The guard scans TEXT NODES: that is the granularity of
// "a phrase that labels a number".
// ---------------------------------------------------------------------------

export const FORBIDDEN_SINGLE_TOTAL_PATTERNS: {
  id: string;
  pattern: RegExp;
}[] = [
  { id: "number_then_consents", pattern: /\b\d[\d,]*\s+consents?\b/i },
  {
    id: "consents_then_number",
    pattern: /\bconsents?\b\s*[(:]?\s*\d[\d,]*/i,
  },
  { id: "total_consents_label", pattern: /\btotal\s+consents?\b/i },
  { id: "consents_total_label", pattern: /\bconsents?\s+total\b/i },
];

/** The id of the forbidden pattern this text matches, or null. */
export function findForbiddenSingleTotal(text: string): string | null {
  for (const { id, pattern } of FORBIDDEN_SINGLE_TOTAL_PATTERNS) {
    if (pattern.test(text)) return id;
  }
  return null;
}

/** Every offending string in a set of text nodes. Empty means the rule holds. */
export function forbiddenSingleTotalsIn(texts: string[]): string[] {
  return texts.filter((text) => findForbiddenSingleTotal(text) !== null);
}
