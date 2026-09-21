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
// ONE rule, in two granularities. The rule: a string is forbidden when the word
// "consent(s)", standing alone, is within N characters of a number — plus two
// digitless label patterns ("total consents", "consents total"), because a label
// that claims a total is the misreport whether or not it prints the number.
//
// LANE 2 FOUND THE HOLE IN THE FIRST VERSION OF THIS (worker2,
// `.prime/handoff/verify-lane/scanner-proof/scanner-proof.test.ts`, 13 tests,
// bun 1.4.0; I reproduced it: 13 pass). A NODE-LEVEL scan cannot see the ordinary
// way an operator-facing total is rendered:
//
//     <tr><th>Consents</th><td>281</td></tr>      ->  two text nodes
//
// The label and the value are different text nodes, so the guard passed a screen
// that plainly reads "Consents 281". The old comment in this file DESCRIBED that
// split while the guard could not OBSERVE it — a comment describing a hole the
// guard cannot see is worse than no comment. Hence the VISUAL UNIT scan below.
//
// WHAT IS EXEMPT, DELIBERATELY:
//
//  - the word must stand ALONE. `oauth2_consent_session`,
//    `every_consent_subject_resolves_to_a_username` and
//    `oauth2_consent_preconfiguration` are identifiers, not labels, and the
//    underscore is part of the token — so they can never fire. Without this, a
//    shipped assertion NAME would trip the guard on every health page.
//  - a string with NO number is exempt however close the word is: that is what
//    keeps the server's own label "never answered — the consent screen was shown
//    and no response was recorded" safe.
//
// WHAT THIS GUARD IS, AND IS NOT. It is a BACKSTOP FOR A CARELESS LABEL. It is
// not the protection: the protection is STRUCTURAL — the consent panel renders
// named populations and never sums them, and the classifier asks `responded_at`
// first. A rule about words cannot enforce a rule about arithmetic, and a green
// scan is not coverage (see the asserted MISSES in the unit test beside this
// module).
// ---------------------------------------------------------------------------

/**
 * The word, standing alone. The lookarounds keep identifier tokens out —
 * `oauth2_consent_session`, `every_consent_subject_resolves_to_a_username` — by
 * refusing a LETTER or underscore on either side. A DIGIT on either side is
 * allowed, and that is deliberate: it is the no-separator DOM shape
 * (`textContent` of `<th>Consents</th><td>281</td>` is `Consents281`), which a
 * UNIT test caught this rule missing while the standalone check was too greedy.
 * A label glued to its value is exactly what this guard is for.
 */
const CONSENT_WORD = /(?<![A-Za-z_])consents?(?![A-Za-z_])/gi;

/** A number, for adjacency. */
const A_NUMBER = /\d+/g;

/**
 * An ISO-8601 date or time literal. EXCLUDED from "a number" on purpose, and the
 * exclusion is MEASURED rather than stylistic: the closest legitimate unit this
 * console renders was "the window applied to the consent views:
 * 2026-06-23T00:00:00Z", a gap of 8 — a false positive, because a timestamp is
 * not a count and no label totals one. Excluding date/time literals is what makes
 * the unit window able to reach the split shapes (gap 0..2) without firing on a
 * date range that merely sits after a colon.
 *
 * This does NOT open the hole it looks like it might: a careless label such as
 * "Consents (2026-09-21): 281" still fires, because only the date is excluded and
 * "281" is still a number inside the window.
 */
const ISO_DATE_OR_TIME =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{4}\/\d{2}\/\d{2}|\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g;

/** The numbers that are COUNTS: every `\d+` span that is not inside a date/time. */
function countableNumberSpans(text: string): Array<[number, number]> {
  const dates = spans(text, ISO_DATE_OR_TIME);
  return spans(text, A_NUMBER).filter(
    ([start, end]) => !dates.some(([ds, de]) => start >= ds && end <= de),
  );
}

/**
 * The NODE window, in characters, between the word "consent(s)" and the nearest
 * number inside ONE text node. 20, for two MEASURED reasons:
 *
 *  - LOWER BOUND, must be >= 8: the escape `consent count: 281` has a gap of
 *    exactly 8 characters. A tighter window misses it.
 *  - UPPER BOUND, must be < 26: the smallest gap in the copy this console
 *    actually renders is 26, in the access-audit note
 *    "design §3.6 requires an access row per consent read".
 *
 * So the usable band is 8..25, and 20 sits inside it: 2.5x the escape's gap, 6
 * characters clear of the false-positive floor. Pinned by tests on BOTH edges.
 */
export const CONSENT_TOTAL_ADJACENCY_WINDOW = 20;

/**
 * The VISUAL-UNIT window. A container's text is scanned as one string, which is
 * how a label and its value are read by a person, and which is what closes the
 * split-node hole lane 2 found. It has its OWN window, chosen from MEASUREMENTS
 * taken at this granularity (both taken on the rendered console, live capture, all
 * four views, every unit):
 *
 *  - LOWER BOUND: the shapes this must catch. "<tr><th>Consents</th><td>281</td>"
 *    joins to a gap of 1; cells without separators give 0; "Consents: 281" gives
 *    2; and the longest label-plus-value form worth catching, "Consents (all
 *    clients): 281", gives 15. So the window must be >= 15 to cover what the unit
 *    scan is for, and >= 2 to cover the tightest forms.
 *  - UPPER BOUND: the closest LEGITIMATE unit is 25 characters — the population
 *    row "Never answered 46 no never answered — the consent screen was shown and
 *    no response was recorded …" — and the next is 28, the access-audit note.
 *    So the window must stay below 25.
 *
 * 18 sits between them: it covers every shape above (the widest at 15), and keeps
 * a 7-character margin below the measured false-positive floor. Note what this is
 * NOT: the reason a split shape needs the unit scan rather than a bigger NODE
 * window is that widening the node window to 15+ would still not see two nodes,
 * and widening it to reach the run-together case would put the 26-character
 * legitimate node copy in range.
 *
 * A NOTE ON THE MEASUREMENT THAT SET THIS. The first pass measured a legitimate
 * unit at a gap of 8 — "the window applied to the consent views:
 * 2026-06-23T00:00:00Z" — which would have forced this window below 8 and made
 * the visible split shapes unreachable. That was a FALSE POSITIVE, not a caught
 * misreport, and the honest fix was to stop calling a timestamp "a number" (see
 * ISO_DATE_OR_TIME) rather than to shrink the window around it.
 */
export const CONSENT_UNIT_ADJACENCY_WINDOW = 18;

/**
 * The containers a visual unit may be. BOUNDED ON PURPOSE — the nearest one wins
 * and the walk stops there, so the false-positive surface does not grow into
 * "the whole page is one unit". These are the structures that render a label and
 * a value as one visual whole: a table row, a definition list, a list item, a
 * figure. A component that renders a card marks itself with `[data-scan-unit]`,
 * which the DOM adapter reports as `scanUnit: true`.
 */
export const CONSENT_SCAN_CONTAINERS: readonly string[] = [
  "tr",
  "dl",
  "dt",
  "dd",
  "li",
  "figure",
];

/**
 * Digitless forbidden labels. These are NOT phrasings chasing an escape: they are
 * a different shape — a label that names a total of decisions. No number is
 * needed for that to be the misreport, so adjacency cannot catch it.
 */
export const FORBIDDEN_TOTAL_LABELS: { id: string; pattern: RegExp }[] = [
  { id: "total_consents_label", pattern: /\btotal\s+consents?\b/i },
  { id: "consents_total_label", pattern: /\bconsents?\s+total\b/i },
];

/** Every span of a pattern in a text, as [start, end) offsets. */
function spans(text: string, pattern: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match = re.exec(text);
  while (match !== null) {
    out.push([match.index, match.index + match[0].length]);
    match = re.exec(text);
  }
  return out;
}

/**
 * The gap in characters between two spans. 0 when they touch or overlap, so a
 * number INSIDE the matched word counts as adjacent.
 */
function gapBetween(a: [number, number], b: [number, number]): number {
  if (a[1] <= b[0]) return b[0] - a[1];
  if (b[1] <= a[0]) return a[0] - b[1];
  return 0;
}

/** The digitless label rule. */
function forbiddenLabel(text: string): string | null {
  for (const { id, pattern } of FORBIDDEN_TOTAL_LABELS) {
    if (pattern.test(text)) return id;
  }
  return null;
}

/** The adjacency rule at a given window. Returns the rule id, or null. */
function forbiddenAtWindow(text: string, window: number): string | null {
  const label = forbiddenLabel(text);
  if (label) return label;
  const words = spans(text, CONSENT_WORD);
  if (words.length === 0) return null;
  const numbers = countableNumberSpans(text);
  if (numbers.length === 0) return null;
  for (const word of words) {
    for (const number of numbers) {
      if (gapBetween(word, number) <= window) {
        return `consent_word_within_${window}_chars_of_a_number`;
      }
    }
  }
  return null;
}

/** The smallest gap between the word and any number, or null when one is absent. */
export function consentNumberGap(text: string): number | null {
  const words = spans(text, CONSENT_WORD);
  const numbers = countableNumberSpans(text);
  if (words.length === 0 || numbers.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const word of words) {
    for (const number of numbers) {
      best = Math.min(best, gapBetween(word, number));
    }
  }
  return best === Number.POSITIVE_INFINITY ? null : best;
}

/**
 * The id of the rule this TEXT NODE breaks, or null. Unchanged from the first
 * version: the easy shapes must behave identically (lane 2's suite asserts this).
 */
export function findForbiddenSingleTotal(text: string): string | null {
  return forbiddenAtWindow(text, CONSENT_TOTAL_ADJACENCY_WINDOW);
}

/**
 * The id of the rule this VISUAL UNIT breaks, or null. A unit is a container's
 * whole text, so "Consents" and "281" in sibling cells arrive as one string and
 * the split-node hole is closed.
 */
export function findForbiddenVisualUnit(unitText: string): string | null {
  return forbiddenAtWindow(unitText, CONSENT_UNIT_ADJACENCY_WINDOW);
}

/** Every offending text node. Empty means the node-granularity rule holds. */
export function forbiddenSingleTotalsIn(texts: string[]): string[] {
  return texts.filter((text) => findForbiddenSingleTotal(text) !== null);
}

/** Every offending visual unit. Empty means the unit-granularity rule holds. */
export function forbiddenVisualUnitsIn(unitTexts: string[]): string[] {
  return unitTexts.filter((text) => findForbiddenVisualUnit(text) !== null);
}

// ---------------------------------------------------------------------------
// The visual-unit walk
//
// Kept DOM-free so it is UNIT-TESTABLE beside this module, and shared with the
// e2e spec: the spec's only job is to turn real elements into this descriptor
// shape, so the unit selection lives in one place instead of in a test.
// ---------------------------------------------------------------------------

export type ScanElement = {
  /** Lower-case tag name. */
  tag: string;
  /** This element's OWN direct text, whitespace-collapsed. Empty when none. */
  text: string;
  children: ScanElement[];
  /** Set by the DOM adapter for an element carrying `[data-scan-unit]`. */
  scanUnit?: boolean;
};

function isContainer(el: ScanElement, containers: readonly string[]): boolean {
  return el.scanUnit === true || containers.includes(el.tag);
}

/** A container's whole text, children joined with one space (as `innerText` does). */
export function visualUnitText(el: ScanElement): string {
  const parts: string[] = [];
  const walk = (node: ScanElement) => {
    const own = node.text.replace(/\s+/g, " ").trim();
    if (own !== "") parts.push(own);
    for (const child of node.children) walk(child);
  };
  walk(el);
  return parts.join(" ");
}

/**
 * The visual units under a root: the NEAREST container for each, and no nesting.
 * A container's own subtree is not searched again, which is what keeps one
 * careless card from turning the whole page into a single unit.
 */
export function collectVisualUnits(
  root: ScanElement,
  containers: readonly string[] = CONSENT_SCAN_CONTAINERS,
): string[] {
  const out: string[] = [];
  const walk = (el: ScanElement) => {
    if (isContainer(el, containers)) {
      const unit = visualUnitText(el);
      if (unit !== "") out.push(unit);
      return;
    }
    for (const child of el.children) walk(child);
  };
  walk(root);
  return out;
}

/** The visual units of a tree that break the unit rule, with their unit text. */
export function forbiddenUnitsInTree(
  root: ScanElement,
  containers: readonly string[] = CONSENT_SCAN_CONTAINERS,
): string[] {
  return forbiddenVisualUnitsIn(collectVisualUnits(root, containers));
}
