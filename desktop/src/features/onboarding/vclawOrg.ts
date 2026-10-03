import {
  SEGMENT_GROUP_CANONICAL_PREFIX,
  SEGMENT_GROUP_LEGACY_PREFIX,
  SEGMENT_GROUP_PREFIXES,
  SEGMENT_LEGACY_SUNSET,
  type SegmentGroupEntry,
  segmentGroupEntry,
} from "./vclawCommunityProvision";

/**
 * THE ORG FIELD — one name, no catalogue, and the ESTATE as the authority.
 *
 * Operator requirements, 2026-10-03, in his words:
 *   1. "offer org selector, default is 'vclaw', and allow user to specify / verify her org / segment
 *      name";
 *   2. "don't list all segments available, simply offer either the default 'vclaw' or a keyword
 *      (segment / org name) the user is given".
 *
 * WHY ONE FIELD AND NOT A SELECTOR: a list of the estate's tenant names is a catalogue of who the
 * estate serves. It would also invite a person to pick an org they were never given — and the pick
 * would be a claim the client cannot substantiate. So: ONE text field, pre-filled `vclaw` (the
 * default, SHOWN rather than assumed), which accepts the keyword the operator was told.
 *
 * ── WHAT IS CHECKED HERE, AND WHAT IS NOT (docs/UI_INPUT_VALIDATION.md) ───────────────────────────
 * HERE (local, before the token): required, trimmed, case-folded, length 2–63, charset
 * `[a-z0-9]` with `- _ .` between. This is SHAPE only, and it gates the button: while the entry is
 * invalid there is no next step at all.
 *
 * THERE (authoritative, immediately after the token arrives): the estate's own claim decides. An
 * unauthenticated "does this org exist" route was NOT added — verification belongs behind the
 * credential it verifies. If the claim does not grant the entered org, the sign-in STOPS before the
 * community is entered and says so (`verifyOrgAgainstClaim` → `not-granted`).
 *
 * NOTHING IS SUBSTITUTED. `vclaw.tenant.<name>` is the canonical group and `vchat.tenant.<name>` is
 * the legacy alias (sunset 2026-11-02, marked as legacy rather than shown as current); when the
 * estate's answer is not textually what was entered, BOTH are shown. There is deliberately no
 * `default` → `vclaw` mapping here: the room plane renames that segment VALUE, and a UI that
 * translated one name into the other would be asserting an alias the estate never confirmed.
 */

/** The pre-filled default. Shown in the field, never assumed from an empty field. */
export const VCLAW_DEFAULT_ORG = "vclaw";

export const VCLAW_ORG_MIN_LENGTH = 2;
export const VCLAW_ORG_MAX_LENGTH = 63;

/** One segment name: alphanumeric at both ends, `- _ .` allowed between. */
const ORG_NAME_SHAPE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** What the field tells the user BEFORE they type: what is accepted. */
export const VCLAW_ORG_ACCEPTED_HINT =
  `Accepted: ${VCLAW_ORG_MIN_LENGTH}–${VCLAW_ORG_MAX_LENGTH} characters — letters a–z, ` +
  "digits 0–9, and - _ . between them. Case does not matter (it is folded). " +
  "No list of orgs is offered here: keep the default " +
  `\`${VCLAW_DEFAULT_ORG}\`, or type the org name you were given.`;

/** The entry, split into the parts the checks and the verdict need. */
export type OrgEntry = {
  /** Exactly what the field held. */
  raw: string;
  /** Trimmed. This is what the verdict shows as "you entered". */
  trimmed: string;
  /** The bare name, case-folded, with a known group prefix stripped. What is compared. */
  folded: string;
  /** The group prefix the entry carried, if the user pasted a full group name. */
  prefix: string | null;
  /** True when that prefix was the LEGACY alias. */
  legacyPrefix: boolean;
};

export type OrgProblem = "empty" | "too-short" | "too-long" | "shape";

export type OrgValidation = {
  /** True only when there is a next step. Invalid ⇒ the caller must not progress. */
  ok: boolean;
  entry: OrgEntry;
  /** `null` when `ok`. */
  problem: OrgProblem | null;
  /** The prompt: what was accepted, or what is wrong and what would be right. */
  message: string;
};

/** Trim, case-fold, and strip a known group prefix so a pasted group name verifies too. */
export function parseOrgEntry(raw: string): OrgEntry {
  const trimmed = raw.trim();
  const foldedInput = trimmed.toLowerCase();
  const prefix =
    SEGMENT_GROUP_PREFIXES.find((candidate) =>
      foldedInput.startsWith(candidate),
    ) ?? null;
  const bare = prefix ? trimmed.slice(prefix.length).trim() : trimmed;
  return {
    raw,
    trimmed,
    folded: bare.toLowerCase(),
    prefix,
    legacyPrefix: prefix === SEGMENT_GROUP_LEGACY_PREFIX,
  };
}

/** The local check. Shape only — the estate's claim is the authority (see the file header). */
export function validateOrgEntry(raw: string): OrgValidation {
  const entry = parseOrgEntry(raw);
  const fail = (problem: OrgProblem, message: string): OrgValidation => ({
    ok: false,
    entry,
    problem,
    message,
  });

  if (!entry.trimmed) {
    return fail(
      "empty",
      `Enter your org: keep the default \`${VCLAW_DEFAULT_ORG}\`, or type the org name you were given.`,
    );
  }
  if (!entry.folded) {
    return fail(
      "empty",
      `"${entry.trimmed}" is a group prefix with no org name in it. Type the org name you were given.`,
    );
  }
  if (entry.folded.length < VCLAW_ORG_MIN_LENGTH) {
    return fail(
      "too-short",
      `"${entry.trimmed}" is too short — an org name is at least ${VCLAW_ORG_MIN_LENGTH} characters.`,
    );
  }
  if (entry.folded.length > VCLAW_ORG_MAX_LENGTH) {
    return fail(
      "too-long",
      `"${entry.trimmed}" is too long — an org name is at most ${VCLAW_ORG_MAX_LENGTH} characters.`,
    );
  }
  if (!ORG_NAME_SHAPE.test(entry.folded)) {
    return fail(
      "shape",
      `"${entry.trimmed}" is not an org name this estate uses — letters a–z, digits 0–9, and - _ . between them; case does not matter.`,
    );
  }

  const foldedNote =
    entry.folded === entry.trimmed
      ? `Org \`${entry.folded}\` accepted`
      : `Org \`${entry.folded}\` accepted (case-folded from "${entry.trimmed}")`;
  const prefixNote = entry.legacyPrefix
    ? ` — note the LEGACY prefix \`${SEGMENT_GROUP_LEGACY_PREFIX}\`; canonical is \`${SEGMENT_GROUP_CANONICAL_PREFIX}\` (vchat is sunset ${SEGMENT_LEGACY_SUNSET}).`
    : entry.prefix
      ? ` — read as a group name with the \`${entry.prefix}\` prefix.`
      : ".";
  return {
    ok: true,
    entry,
    problem: null,
    message: `${foldedNote}${prefixNote} The estate's claim decides whether it is granted, right after the token arrives.`,
  };
}

export type OrgVerdictStatus = "granted" | "legacy" | "not-granted";

/** The estate's answer to the entry — and the one name it granted, never a list. */
export type OrgVerdict = {
  status: OrgVerdictStatus;
  /** The entry, trimmed, exactly as it will be shown back to the user. */
  entered: string;
  /** The case-folded bare name that was compared. */
  normalized: string;
  /** The group the estate granted, or `null` when it granted nothing for this entry. */
  grant: SegmentGroupEntry | null;
  /** True when the estate's answer is not textually the entry — then BOTH are shown. */
  differsFromEntry: boolean;
  /** The user-facing answer. On `not-granted` it names no other org. */
  message: string;
};

/**
 * The ESTATE decides. Compares the entry's case-folded bare name against the tenant groups in the
 * claim, canonical prefix first, legacy alias accepted and MARKED.
 *
 * A miss is a STOP, not a warning: the caller must not provision the community. The miss message
 * deliberately does NOT list the groups the claim does carry — the field renders no catalogue, and
 * the person on the other side is the one who was given their org name.
 */
export function verifyOrgAgainstClaim(
  raw: string,
  groups: readonly string[],
): OrgVerdict {
  const entry = parseOrgEntry(raw);
  const granted = groups
    .map((group) => segmentGroupEntry(group))
    .filter((group): group is SegmentGroupEntry => group !== null);
  const canonical =
    granted.find((group) => !group.legacy && group.name === entry.folded) ??
    null;
  const legacy =
    granted.find((group) => group.legacy && group.name === entry.folded) ??
    null;
  const grant = canonical ?? legacy;

  if (!grant) {
    return {
      status: "not-granted",
      entered: entry.trimmed,
      normalized: entry.folded,
      grant: null,
      differsFromEntry: true,
      message:
        `The estate did not grant the org "${entry.trimmed}" — its claim for this identity answers with no such org name, so this build stopped before entering the community. ` +
        `Nothing was substituted for the name you entered, and no community was entered. ` +
        `Sign in with the org name you were given (the default is \`${VCLAW_DEFAULT_ORG}\`).`,
    };
  }

  const differsFromEntry =
    entry.trimmed.toLowerCase() !== grant.group.toLowerCase();
  const both = differsFromEntry
    ? ` You entered "${entry.trimmed}"; the estate's answer is "${grant.group}" (${grant.displayName}) — both are shown, and neither is substituted for the other.`
    : "";

  if (grant.legacy) {
    return {
      status: "legacy",
      entered: entry.trimmed,
      normalized: entry.folded,
      grant,
      differsFromEntry,
      message:
        `The estate answered with the LEGACY alias "${grant.group}" (${grant.displayName}) — this is not the canonical group. ` +
        `Canonical is "${grant.canonicalGroup}". \`${SEGMENT_GROUP_LEGACY_PREFIX}\` is accepted only while the estate migrates, and vchat is sunset ${SEGMENT_LEGACY_SUNSET}.` +
        both,
    };
  }

  return {
    status: "granted",
    entered: entry.trimmed,
    normalized: entry.folded,
    grant,
    differsFromEntry,
    message: `The estate granted your org: "${grant.group}" (${grant.displayName}).${both}`,
  };
}
