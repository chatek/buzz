import { getIdentity } from "@/shared/api/tauriIdentity";
import type { Identity } from "@/shared/api/types";
import { vclawLogin, type VclawOidcAccount } from "@/shared/api/vclawOidc";
import {
  bindVclawPrincipalDevice,
  type VclawBindReport,
} from "@/shared/api/vclawPrincipalBind";
import {
  provisionVclawCommunity,
  type ProvisionResult,
} from "./vclawCommunityProvision";
import { describeVclawBindFailure } from "./lib/vclawBindCopy";
import {
  type OrgVerdict,
  validateOrgEntry,
  verifyOrgAgainstClaim,
} from "./vclawOrg";

/**
 * ONE vclaw sign-in, for every screen that offers it.
 *
 * WHY THIS FILE EXISTS (operator directive 2026-10-03): "VClaw sign-in is the DEFAULT and THE ONLY
 * method". Before this, the sign-in existed on the machine landing screen alone, and the backend
 * (`vclaw_oidc_login`), the community provisioning and the device key were wired together INSIDE
 * that one component — so any second entry point would have had to copy the sequence, and the copy
 * would drift. The sequence lives here once.
 *
 * ── THE ORG COMES FIRST, AND THE ESTATE DECIDES IT (operator requirement 2026-10-03) ────────────
 * The human enters ONE org name (pre-filled `vclaw`, or the keyword they were given), and
 * `signInWithVclaw` carries it. Two different authorities check it, and they are not the same check:
 *
 *   · LOCALLY, `validateOrgEntry` — required, trimmed, case-folded, length and charset. Shape only.
 *     This is what gates the button; it deliberately cannot say whether the org EXISTS.
 *   · AUTHORITATIVELY, `verifyOrgAgainstClaim` — the estate's own claim, read from the token that
 *     just arrived. A miss THROWS (`VclawSignInFailure`, stage `org`) BEFORE the community is
 *     provisioned, so the human never enters a community their claim does not cover, and the
 *     message they see is the estate's answer rather than a client-side guess.
 * No unauthenticated "does this org exist" route was added: verification sits behind the credential
 * it verifies.
 *
 * THE SEQUENCE, AND WHY EACH STEP IS SILENT:
 *
 *   1. `vclawLogin()` — the IdP round trip. The ONLY step a human performs.
 *   2. `verifyOrgAgainstClaim()` — the estate's answer to the entered org. A miss stops the
 *      sequence here, loudly, and nothing below runs.
 *   3. `getIdentity()` — the device key. The Rust layer ALREADY resolved it at boot
 *      (`app_state.rs` `generate_and_persist`, the "generated and saved identity pubkey" line) and
 *      hands it back as an implementation detail of the relay. This call ASKS FOR IT; it never asks
 *      the human to create, import, back up or confirm one. That is the whole correction: the key
 *      already existed, the UI was making it a step.
 *   4. `bindVclawPrincipalDevice()` — THE DEVICE BINDING, and it sits HERE (job A1,
 *      `docs/AUTH_BIND_PLAN.md`) for a reason that is not stylistic: the relay authorises by npub,
 *      so the first authorised request this app makes is the one that needs the row. Binding after
 *      the community is provisioned or after the app mounts would race the app's own refusal, and
 *      the loser of that race is the person, looking at an empty shell. A failure stops the sequence
 *      here, loudly, and NOTHING below runs — including the handoff that mounts the app, which is
 *      what A2 means by "never a silently empty app".
 *   5. `provisionVclawCommunity()` — the estate community, from the IdP's segment groups, so the
 *      operator never sees a community picker. Persists directly (see the note in useCommunities).
 *   6. `writeVclawLink()` — the vclaw SUBJECT recorded BESIDE the device key, linked, not merged.
 *      Design B, stated in MachineOnboardingFlow's identity step: the app keeps its OWN Nostr key
 *      and the subject is recorded next to it. Deriving the key FROM the subject was rejected
 *      because it would make the messaging key computable by anything that can mint a subject,
 *      turning the IdP into a key forge — the estate's own high-severity finding, rebuilt in the app.
 *      The link is best effort: a refusal to persist must not block the sign-in that just succeeded.
 *
 * THE LINK IS PERSISTED, NOT JUST DISPLAYED. Until now the subject lived in React state for the
 * length of one render pass and vanished; "linked, not merged" was a claim in a caption. Keyed by
 * pubkey so that replacing the device key cannot inherit another key's subject.
 */

const VCLAW_LINK_STORAGE_KEY = "buzz-vclaw-link.v1";

/** The vclaw account as recorded beside a device key. */
export type VclawLink = {
  /** The IdP subject (`sub`), as the Rust boundary names it: `subject`. */
  subject: string;
  email: string | null;
  /** ISO-8601, so a later session can tell when the link was made. */
  linkedAt: string;
  /**
   * The org the ESTATE granted for this sign-in, kept so the answer outlives the screen that showed
   * it: `entered` is what the human typed and `grant.group` is the estate's own string, so a later
   * reader can see both without re-asking. `null` for a link written before the org field existed.
   * A link is only ever written for a GRANTED (or legacy-granted) org — a miss stops the sequence.
   */
  org: OrgVerdict | null;
};

export type VclawSignInResult = {
  account: VclawOidcAccount;
  /** The device key the app already holds — never created by this call. */
  identity: Identity;
  /**
   * The device binding, and it is `state: "bound"` here by construction: any other state STOPPED
   * the sequence with [`VclawSignInFailure`]. It is returned rather than asserted so a caller can
   * report WHAT the estate did — and whether the row already existed (`idempotent`).
   */
  bind: VclawBindReport;
  provision: ProvisionResult;
  /** `null` when the link could not be persisted; the sign-in still stands. */
  link: VclawLink | null;
  /** The ESTATE's answer to the entered org; never `not-granted` here (that stops the sequence). */
  org: OrgVerdict;
};

/**
 * A sign-in that stopped, WITH the layer that stopped it.
 *
 * `stage` exists so no caller has to guess: an org refusal reported as `vclaw IdP: ...` sends the
 * reader to the IdP when the claim was the thing that said no — the same wrong-layer message the
 * project's pitfall log already carries. `verdict` carries the estate's answer when there is one,
 * and `bind` carries the device-binding report when the BIND is what stopped the sign-in.
 *
 * ⚠ `"bind"` IS A SEPARATE STAGE FROM `"idp"` ON PURPOSE. "The IdP was unreachable" and "the estate
 * refused to bind this device" have different causes and different next steps, and collapsing them
 * would send a person to the wrong place — which is exactly what A4 forbids.
 */
export class VclawSignInFailure extends Error {
  readonly stage: "org" | "idp" | "bind";
  readonly verdict: OrgVerdict | null;
  /** The binding report, for stage `"bind"`; `null` for every other stage. */
  readonly bind: VclawBindReport | null;

  constructor(
    stage: "org" | "idp" | "bind",
    message: string,
    verdict: OrgVerdict | null = null,
    bind: VclawBindReport | null = null,
  ) {
    super(message);
    this.name = "VclawSignInFailure";
    this.stage = stage;
    this.verdict = verdict;
    this.bind = bind;
  }
}

/** The one place a failure's message is composed, so every caller names the right layer. */
export function describeVclawSignInFailure(cause: unknown): string {
  if (cause instanceof VclawSignInFailure) return cause.message;
  return `vclaw IdP: ${cause instanceof Error ? cause.message : String(cause)}`;
}

function linkStorageKey(pubkey: string) {
  return `${VCLAW_LINK_STORAGE_KEY}:${pubkey}`;
}

/** A recorded org answer is only as good as its own fields: no granted group, no recorded org. */
function readRecordedOrg(value: unknown): OrgVerdict | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<OrgVerdict>;
  const group = candidate.grant?.group;
  if (typeof group !== "string" || !group) return null;
  if (candidate.status !== "granted" && candidate.status !== "legacy")
    return null;
  return candidate as OrgVerdict;
}

/** Read the vclaw subject recorded for a device key, or `null` when none is. */
export function readVclawLink(pubkey: string | null): VclawLink | null {
  if (typeof window === "undefined" || !pubkey) return null;
  try {
    const raw = window.localStorage.getItem(linkStorageKey(pubkey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VclawLink>;
    if (typeof parsed.subject !== "string" || !parsed.subject) return null;
    return {
      subject: parsed.subject,
      email: typeof parsed.email === "string" ? parsed.email : null,
      linkedAt: typeof parsed.linkedAt === "string" ? parsed.linkedAt : "",
      // The org answer is re-checked rather than trusted: an older link has none, and a malformed
      // one must read as "no recorded org" rather than as an org nobody granted.
      org: readRecordedOrg(parsed.org),
    };
  } catch {
    // Unreadable or malformed: no link, rather than a broken onboarding screen.
    return null;
  }
}

/** Record the subject and the granted org beside the device key. `null` when storage refused. */
export function writeVclawLink(
  pubkey: string,
  account: VclawOidcAccount,
  org: OrgVerdict | null,
): VclawLink | null {
  if (typeof window === "undefined" || !pubkey) return null;
  const link: VclawLink = {
    subject: account.subject,
    email: account.email ?? null,
    linkedAt: new Date().toISOString(),
    org,
  };
  try {
    window.localStorage.setItem(linkStorageKey(pubkey), JSON.stringify(link));
  } catch {
    return null;
  }
  return link;
}

/**
 * Complete a vclaw sign-in for ONE org: IdP, then the estate's answer to that org, then the device
 * key, then the DEVICE BINDING, then the estate community, then the link.
 *
 * Throws `VclawSignInFailure` when the entry is not well formed, when the IdP fails, when the
 * estate's claim does not grant the entered org, or when the estate refuses to bind this device.
 * The caller renders the failure and must not progress. The provisioning result is RETURNED rather
 * than asserted, so a caller can report it.
 *
 * ── A1: ONCE PER SIGN-IN, IDEMPOTENTLY, BEFORE THE FIRST AUTHORISED REQUEST ──────────────────────
 * The bind is call site 4 of 6, i.e. after the OIDC callback and BEFORE `provisionVclawCommunity`
 * and before the handoff that mounts the app — the app's first authorised request is made by the
 * shell, so binding later would race the app's own refusal and the person would watch an empty
 * estate win. It happens ONCE per invocation: this sequence runs once per sign-in, and there is no
 * retry loop here (the retry is the person pressing the surface's own control, which re-enters this
 * function deliberately).
 *
 * Idempotence itself is the ENDPOINT's property — J1 keys the row and the device entry, so a second
 * call writes nothing — and the report says so (`idempotent`). The app does not fake it by skipping
 * the call when it thinks a row exists: it cannot read the estate's rows, and a client-side guess
 * about authority is the kind of assertion this estate refuses.
 *
 * `org` is the field's own value; it is validated HERE too, so a caller that bypasses the field
 * cannot sign in with an org nobody checked.
 */
export async function signInWithVclaw(org: string): Promise<VclawSignInResult> {
  const validation = validateOrgEntry(org);
  if (!validation.ok) {
    throw new VclawSignInFailure("org", validation.message);
  }

  let account: VclawOidcAccount;
  try {
    account = await vclawLogin();
  } catch (cause) {
    throw new VclawSignInFailure("idp", describeVclawSignInFailure(cause));
  }

  // THE ESTATE'S CLAIM DECIDES, and it decides HERE: before the device key is read, before the
  // community is provisioned, before anything is written. A miss leaves the app exactly where it
  // was — signed out of the estate — with the reason, rather than inside a community the claim does
  // not cover. The local check above could only ever judge the SHAPE of the name.
  const orgAnswer = verifyOrgAgainstClaim(
    validation.entry.trimmed,
    account.groups,
  );
  if (orgAnswer.status === "not-granted") {
    throw new VclawSignInFailure("org", orgAnswer.message, orgAnswer);
  }

  // Read the device key the Rust layer already holds. Silent by construction:
  // nothing here renders, prompts, or asks the human to handle a key.
  const identity = await getIdentity();

  // A1 — THE BIND, ONCE, AND BEFORE ANYTHING AUTHORISED HAPPENS. The token and the NIP-98 proof are
  // presented by the native layer, not from here (see `vclawPrincipalBind.ts`): this call crosses
  // the IPC boundary with no arguments and gets an OUTCOME back, never a credential.
  //
  // A FAILURE STOPS THE SEQUENCE, and that is the point rather than a side effect: the alternative
  // is to enter a shell whose relay requests the estate will refuse, which renders as an app with no
  // agents and no error — the defect A2 exists to remove. `stage: "bind"` carries the state, so the
  // screen can say WHICH thing is wrong (A4) instead of blaming the IdP.
  const bind = await bindVclawPrincipalDevice(identity.pubkey);
  if (bind.state !== "bound") {
    throw new VclawSignInFailure(
      "bind",
      describeVclawBindFailure(bind),
      orgAnswer,
      bind,
    );
  }

  const provision = provisionVclawCommunity(account.groups);
  const link = writeVclawLink(identity.pubkey, account, orgAnswer);
  return { account, identity, bind, provision, link, org: orgAnswer };
}
