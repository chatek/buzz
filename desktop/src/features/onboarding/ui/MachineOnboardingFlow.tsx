import * as React from "react";
import type { QueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";

import {
  getIdentity,
  importIdentity,
  persistCurrentIdentity,
} from "@/shared/api/tauriIdentity";
import type { IdentityStorage } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { vclawSession } from "@/shared/api/vclawOidc";
import {
  type ProvisionResult,
  VCLAW_RELAY_URL,
} from "../vclawCommunityProvision";
import {
  describeVclawSignInFailure,
  signInWithVclaw,
  VclawSignInFailure,
} from "../vclawSignIn";
import type { OrgVerdict } from "../vclawOrg";
import { VclawOrgField } from "./VclawOrgField";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { BackupStep } from "./BackupStep";
import { DefaultConfigStep } from "./DefaultConfigStep";
import { DownloadKeyStep } from "./DownloadKeyStep";
import {
  backupSessionToPasswordEntry,
  resetEncryptedBackupSession,
  useEncryptedBackupSession,
} from "./EncryptedBackupCreator";
import {
  IdentityKeyHelpContent,
  IdentityKeyHelpDialog,
} from "./IdentityKeyHelpDialog";
import { IdentityKeyIntroduction } from "./IdentityKeyIntroduction";
import { IdentityRecoveryPairing } from "./IdentityRecoveryPairing";
import { LandingBees } from "./LandingBees";
import {
  NostrKeyImportForm,
  type NostrKeyImportStage,
} from "./NostrKeyImportForm";
import {
  ONBOARDING_LANDING_CTA_CLASS,
  ONBOARDING_SECONDARY_CTA_CLASS,
} from "./OnboardingChrome";
import { OnboardingCard } from "./OnboardingCard";
import { OnboardingFooterProvider } from "./OnboardingFooter";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "./OnboardingSlideTransition";
import { SetupStep } from "./SetupStep";
import type { HarnessConnectionMethod } from "./harnessConnectionOptions";
import type { DefaultConfigDraft } from "./types";

export type MachineOnboardingPage =
  | "identity"
  | "identity-key-intro"
  | "identity-key-help"
  | "key-import"
  | "backup"
  | "setup"
  | "config";

/**
 * ── VCLAW SIGN-IN IS THE ONLY METHOD — the gate (operator directive 2026-10-03) ──────────────
 * The operator, after walking the shipped 0.5.24 build and getting stuck: "hide other login methods
 * until I say it's time to re-enable them", and "VClaw sign-in is the DEFAULT and THE ONLY method".
 *
 * WHAT IS HIDDEN: the upstream login methods and the key-material pages behind them —
 * `identity-key-intro` (create a key), `key-import` (import a key), `identity-key-help` (the help
 * surface attached to that key step) and `backup` (back up and confirm the device key).
 *
 * WHY: the upstream default made the human CREATE A PRIVATE KEY to sign in. The app's own log shows
 * it — `buzz-desktop: generated and saved identity pubkey b08d563d…` — and the UI then asked the
 * operator to walk that key as a step. The key is an implementation detail of the relay: the Rust
 * layer already resolved it at boot (`app_state.rs` `generate_and_persist`). Signing in is the
 * human's step. Handling a key is not.
 *
 * HIDDEN, NOT DELETED: every page and every button stays in source. ONE constant restores them all —
 * `VCLAW_SIGN_IN_ONLY` — and the pages it hides are listed in `VCLAW_SIGN_IN_ONLY_HIDDEN_PAGES`.
 * Set it false and the create-key, import-key, key-help and backup pages come back as they were.
 *
 * UNREACHABLE, NOT MERELY INVISIBLE: the constant is read in exactly ONE place,
 * `vclawSignInOnlyRefusesPage`, and BOTH the initial-page normaliser and the `showPage` choke point
 * call that helper. A card, a resumed page, a deep link or a future caller therefore cannot land on
 * a hidden page. Not rendering them alone would not be a gate.
 *
 * IDENTITY LOST IS NOT A LOGIN METHOD: when the app itself reports the identity lost (keyring
 * cleared, and no key backup to fall back on), `key-import` and `backup` stay reachable — that
 * operator still has to recover a key that exists somewhere else, and refusing them would strand
 * them. The gate refuses those pages only as ways to SIGN IN.
 */
const VCLAW_SIGN_IN_ONLY = true;
const VCLAW_SIGN_IN_ONLY_HIDDEN_PAGES: ReadonlySet<MachineOnboardingPage> =
  new Set([
    "identity-key-intro",
    "identity-key-help",
    "key-import",
    "backup",
  ] as const);
const VCLAW_SIGN_IN_ONLY_RECOVERY_PAGES: ReadonlySet<MachineOnboardingPage> =
  new Set(["key-import", "backup"] as const);

/** The gate, in one place. `true` means this page must not be shown. */
function vclawSignInOnlyRefusesPage(
  page: MachineOnboardingPage,
  identityLost: boolean,
) {
  if (!VCLAW_SIGN_IN_ONLY) return false;
  if (!VCLAW_SIGN_IN_ONLY_HIDDEN_PAGES.has(page)) return false;
  return !(identityLost && VCLAW_SIGN_IN_ONLY_RECOVERY_PAGES.has(page));
}

type BackupSubview = "created" | "password";

export function MachineOnboardingFlow({
  complete,
  continueWithIdentity,
  continueWithRecoveredIdentity,
  identityLost,
  initialPage,
  queryClient,
}: {
  complete: (
    pubkey?: string,
    options?: { continueToProfile?: boolean },
  ) => void;
  continueWithIdentity: (pubkey: string) => void;
  continueWithRecoveredIdentity: (pubkey: string) => void;
  identityLost: boolean;
  initialPage?: MachineOnboardingPage;
  queryClient: QueryClient;
}) {
  const [page, setPage] = React.useState<MachineOnboardingPage>(() => {
    const firstPage = identityLost ? "key-import" : (initialPage ?? "identity");
    // A resumed page (`initialPage`) must not open a page the gate refuses. This is one half of the
    // gate; the other half is in showPage, and both read the one helper above.
    return vclawSignInOnlyRefusesPage(firstPage, identityLost)
      ? "identity"
      : firstPage;
  });
  const [transitionDirection, setTransitionDirection] =
    React.useState<OnboardingTransitionDirection>("forward");
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, setIsPending] = React.useState(false);
  const [isVclawPending, setIsVclawPending] = React.useState(false);
  const [vclawResult, setVclawResult] = React.useState<string | null>(null);
  // The vclaw account, kept so the identity step can show WHICH subject this
  // device's key will be linked to. B is the chosen design: the app keeps its OWN
  // Nostr key and the vclaw subject is RECORDED BESIDE IT — linked, not merged.
  // A (deriving the key from the subject) was rejected because it would make the
  // messaging key computable by anything that can mint a subject, so the IdP would
  // become a key forge — the estate's own high-severity finding, rebuilt in the app.
  const [vclawAccount, setVclawAccount] = React.useState<{
    subject: string;
    email?: string | null;
  } | null>(null);
  // What the segment -> community provisioning actually did, so the identity step
  // can REPORT it rather than assert it.
  const [vclawProvision, setVclawProvision] =
    React.useState<ProvisionResult | null>(null);
  // THE ESTATE'S ANSWER TO THE ORG — shown, not summarised. `null` before a sign-in and after a
  // STOP, because a miss grants nothing to show. It is also what the link records, so the answer
  // outlives this screen (see vclawSignIn.ts).
  const [vclawOrg, setVclawOrg] = React.useState<OrgVerdict | null>(null);
  // Set once the org is granted and the key is ready, so the app is entered AFTER the verdict has
  // been committed (see the effect below).
  const [vclawSettled, setVclawSettled] = React.useState<{
    pubkey: string;
    identity: Awaited<ReturnType<typeof getIdentity>>;
  } | null>(null);
  const completedSignInRef = React.useRef(false);
  // Probe for an EXISTING vclaw session on mount, headlessly. Two purposes: it
  // proves the non-interactive path (`vclaw_oidc_session`) as well as the
  // interactive one, and it tells the operator whether a token is already
  // cached before they press the button.
  React.useEffect(() => {
    let cancelled = false;
    void vclawSession()
      .then((account) => {
        if (cancelled || !account) return;
        setVclawResult(
          `vclaw IdP: existing session for sub=${account.subject}` +
            (account.email ? ` (${account.email})` : ""),
        );
      })
      .catch(() => {
        /* not logged in, or the IdP is unreachable — the button is the test */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [identityWasImported, setIdentityWasImported] = React.useState(false);
  const [keyImportStage, setKeyImportStage] =
    React.useState<NostrKeyImportStage>("key-entry");
  const [isKeyImporting, setIsKeyImporting] = React.useState(false);
  const [keyImportFormKey, setKeyImportFormKey] = React.useState(0);
  const [keyImportDialog, setKeyImportDialog] = React.useState<
    "backup" | "phone" | null
  >(null);
  const [identityKeyHelpReturnPage, setIdentityKeyHelpReturnPage] =
    React.useState<"identity" | "identity-key-intro">("identity");
  const [phoneRecoveryStep, setPhoneRecoveryStep] = React.useState("loading");
  const [selectedPubkey, setSelectedPubkey] = React.useState<string | null>(
    null,
  );
  const [identityStorage, setIdentityStorage] = React.useState<
    IdentityStorage | undefined
  >();
  const [readyRuntimeIds, setReadyRuntimeIds] = React.useState<string[]>([]);
  const [setupBackAction, setSetupBackAction] = React.useState<
    (() => void) | null
  >(null);
  const [harnessConnectionMethod, setHarnessConnectionMethod] =
    React.useState<HarnessConnectionMethod | null>(null);
  const [configBackTarget, setConfigBackTarget] = React.useState<
    "method" | "list"
  >("method");
  const [isChoosingDifferentHarness, setIsChoosingDifferentHarness] =
    React.useState(false);
  const [defaultConfigDraft, setDefaultConfigDraft] =
    React.useState<DefaultConfigDraft | null>(null);
  const [isDefaultConfigSaving, setIsDefaultConfigSaving] =
    React.useState(false);
  const [backupSubview, setBackupSubview] =
    React.useState<BackupSubview>("created");
  const [backupDirection, setBackupDirection] = React.useState<
    "forward" | "backward"
  >("forward");
  const [returningFromSecurity, setReturningFromSecurity] =
    React.useState(false);
  // Owned here so switching between the onboarding card and the security
  // subview keeps the created backup, password, and test progress.
  const backupSession = useEncryptedBackupSession();
  const reduceMotion = useReducedMotion() ?? false;
  const setupSelectionHandoffRef = React.useRef(false);
  const handleReadyRuntimeIdsChange = React.useCallback(
    (runtimeIds: readonly string[]) => {
      if (setupSelectionHandoffRef.current) return;
      setReadyRuntimeIds(Array.from(new Set(runtimeIds)));
    },
    [],
  );
  const handleSetupBackActionChange = React.useCallback(
    (backAction: () => void) =>
      setSetupBackAction((current) =>
        current === backAction ? current : backAction,
      ),
    [],
  );
  // THE choke point of the sign-in-only gate: every navigation below routes through here, so
  // refusing a hidden page once covers every card, resumed page, deep link and future caller.
  const showPage = React.useCallback(
    (
      next: MachineOnboardingPage,
      direction?: OnboardingTransitionDirection,
    ) => {
      if (vclawSignInOnlyRefusesPage(next, identityLost)) return;
      if (direction) setTransitionDirection(direction);
      setPage(next);
    },
    [identityLost],
  );

  // THE SIGN-IN — the only way forward while the gate is on. One sequence, shared with the
  // community-setup screen through `vclawSignIn.ts`: the IdP, then THE ESTATE'S ANSWER TO THE ORG
  // the human entered (a miss stops there, before the community is provisioned), then the device key
  // the Rust layer ALREADY holds (the log line "generated and saved identity pubkey" is that key
  // being made at boot, never by this handler), then the estate community, then the subject recorded
  // beside the key. NO key page is shown, and the human never creates, imports, backs up or
  // confirms a key.
  const signInWithVclawAndContinue = React.useCallback(async (org: string) => {
    setIsVclawPending(true);
    setVclawResult(null);
    setVclawOrg(null);
    setVclawSettled(null);
    completedSignInRef.current = false;
    setError(null);
    try {
      const {
        account,
        identity,
        provision,
        link,
        org: grantedOrg,
      } = await signInWithVclaw(org);
      setVclawAccount({ subject: account.subject, email: account.email });
      setVclawProvision(provision);
      setVclawOrg(grantedOrg);
      setVclawResult(
        `Signed in to vclaw as ${account.subject}` +
          (account.email ? ` (${account.email})` : "") +
          (link
            ? " — the subject is linked to this device's key."
            : " — the subject could NOT be linked to this device's key."),
      );
      // NOTHING ADVANCES YET: the state above is what the estate answered, and the effect below
      // enters the app once that answer has been committed.
      setIsVclawPending(false);
      setVclawSettled({ pubkey: identity.pubkey, identity });
    } catch (cause) {
      // THE STOP IS REPORTED WHERE THE FIELD IS, AND IT NAMES THE RIGHT LAYER: an org the estate
      // does not grant is not an IdP error, and saying "vclaw IdP" here would send the reader to the
      // issuer when the CLAIM was what said no. Nothing was provisioned and no key was touched, so
      // the app stays exactly where it was — signed out of the estate.
      const stopped = cause instanceof VclawSignInFailure ? cause : null;
      setVclawOrg(stopped?.verdict ?? null);
      // An ORG refusal IS the estate's answer, so it renders as the verdict and is NOT repeated as a
      // second sentence: the same reason stated twice reads as two problems.
      setVclawResult(
        stopped?.stage === "org" ? null : describeVclawSignInFailure(cause),
      );
      setIsVclawPending(false);
    }
  }, []);

  // THE ESTATE'S ANSWER IS COMMITTED BEFORE THE APP MOUNTS. `complete()` unmounts this flow, so
  // calling it in the same update as the verdict would commit neither — the org the estate granted
  // would never be rendered anywhere, and the requirement is that the authoritative answer is SHOWN.
  // The verdict is committed first (that is what `vclawSettled` waits on), then this hands the device
  // key on, exactly as the one-step version did.
  React.useEffect(() => {
    if (!vclawSettled || completedSignInRef.current) return;
    completedSignInRef.current = true;
    setSelectedPubkey(vclawSettled.pubkey);
    setIdentityStorage(vclawSettled.identity.storage);
    queryClient.setQueryData(["identity"], vclawSettled.identity);
    // STRAIGHT INTO THE APP, with no key step to walk: the key already exists, and it was never the
    // human's to handle.
    complete(vclawSettled.pubkey, { continueToProfile: true });
  }, [vclawSettled, complete, queryClient]);

  const returnToApiConfig = React.useCallback(() => {
    setIsChoosingDifferentHarness(false);
    showPage("config", "backward");
  }, []);

  const loadFreshIdentity = React.useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const identity = await getIdentity();
      queryClient.setQueryData(["identity"], identity);
      setSelectedPubkey(identity.pubkey);
      setIdentityStorage(identity.storage);
      setBackupDirection("forward");
      setReturningFromSecurity(false);
      setBackupSubview("created");
      showPage("backup", "forward");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load identity",
      );
    } finally {
      setIsPending(false);
    }
  }, [queryClient]);

  const loadRecoveredIdentity = React.useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const identity = await getIdentity();
      continueWithRecoveredIdentity(identity.pubkey);
      queryClient.setQueryData(["identity"], identity);
      setIdentityWasImported(true);
      setSelectedPubkey(identity.pubkey);
      setIdentityStorage(identity.storage);
      showPage("setup", "forward");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load identity",
      );
    } finally {
      setIsPending(false);
    }
  }, [continueWithRecoveredIdentity, queryClient]);

  const replaceLostIdentity = React.useCallback(async () => {
    const confirmed = window.confirm(
      "This will create a new identity and abandon your previous key. This cannot be undone. Continue?",
    );
    if (!confirmed) return;

    setIsPending(true);
    setError(null);
    try {
      const identity = await persistCurrentIdentity();
      queryClient.setQueryData(["identity"], identity);
      setSelectedPubkey(identity.pubkey);
      setIdentityStorage(identity.storage);
      setBackupDirection("forward");
      setReturningFromSecurity(false);
      setBackupSubview("created");
      showPage("backup", "forward");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to save identity",
      );
    } finally {
      setIsPending(false);
    }
  }, [queryClient]);

  const importExistingIdentity = React.useCallback(
    async (nsec: string, password?: string) => {
      const identity = await importIdentity(nsec, password);
      continueWithIdentity(identity.pubkey);
      queryClient.setQueryData(["identity"], identity);
      setIdentityWasImported(true);
      setSelectedPubkey(identity.pubkey);
      showPage("setup", "forward");
    },
    [continueWithIdentity, queryClient],
  );

  const backFromKeyImport = React.useCallback(() => {
    if (keyImportStage === "backup-password") {
      setKeyImportFormKey((current) => current + 1);
      setKeyImportStage("key-entry");
      return;
    }
    if (keyImportDialog) {
      setKeyImportDialog(null);
      setPhoneRecoveryStep("loading");
      return;
    }
    showPage("identity", "backward");
  }, [keyImportDialog, keyImportStage]);

  const returnToCreatedKey = React.useCallback(() => {
    setBackupDirection("backward");
    setReturningFromSecurity(true);
    setBackupSubview("created");
  }, []);

  const backFromPasswordBackup = React.useCallback(() => {
    resetEncryptedBackupSession(backupSession);
    setBackupDirection("backward");
    setReturningFromSecurity(true);
    setBackupSubview("created");
  }, [backupSession]);

  const backFromSetup = React.useCallback(() => {
    if (identityWasImported) {
      setKeyImportFormKey((current) => current + 1);
      setKeyImportStage("key-entry");
      showPage("key-import", "backward");
      return;
    }
    if (backupSubview === "password") {
      backupSessionToPasswordEntry(backupSession);
    }
    setBackupDirection("backward");
    setReturningFromSecurity(false);
    showPage("backup", "backward");
  }, [backupSession, backupSubview, identityWasImported]);

  const backFromConfig = React.useCallback(() => {
    setupSelectionHandoffRef.current = false;
    setIsChoosingDifferentHarness(false);
    if (configBackTarget === "method") {
      setHarnessConnectionMethod(null);
    }
    showPage("setup", "backward");
  }, [configBackTarget]);

  const chromeBackAction =
    page === "identity-key-help"
      ? {
          onClick: () => {
            showPage(identityKeyHelpReturnPage, "backward");
          },
        }
      : page === "identity-key-intro"
        ? {
            disabled: isPending,
            onClick: () => {
              setError(null);
              showPage("identity", "backward");
            },
          }
        : page === "key-import" &&
            (keyImportDialog !== null ||
              !identityLost ||
              keyImportStage === "backup-password")
          ? { disabled: isKeyImporting, onClick: backFromKeyImport }
          : page === "backup" && backupSubview !== "created"
            ? {
                label: "Return to onboarding",
                onClick: returnToCreatedKey,
                testId: "backup-return-to-onboarding",
              }
            : page === "backup"
              ? {
                  onClick: () => {
                    showPage("identity-key-intro", "backward");
                  },
                }
              : page === "setup"
                ? { onClick: setupBackAction ?? backFromSetup }
                : page === "config"
                  ? {
                      disabled: isDefaultConfigSaving,
                      onClick: backFromConfig,
                    }
                  : undefined;

  if (page === "identity") {
    return (
      <div
        className="buzz-onboarding-neutral-theme buzz-startup-shell buzz-onboarding-welcome flex max-h-dvh items-start justify-center overflow-x-hidden overflow-y-auto px-4 py-8 text-foreground"
        data-testid="machine-onboarding-gate"
      >
        <StartupWindowDragRegion />
        <LandingBees />
        <OnboardingFooterProvider>
          <div className="relative my-auto flex w-full max-w-[1040px] flex-col items-center text-center">
            <OnboardingSlideTransition
              className="flex w-full max-w-[720px] flex-col items-center text-center"
              direction={transitionDirection}
              transitionKey={`machine-identity-${transitionDirection}`}
            >
              <img
                alt="Buzz"
                className="w-full max-w-[600px]"
                src="/landing/buzz-wordmark.png"
              />
              <p className="mt-2 max-w-[560px] text-center text-2xl font-normal leading-none text-foreground">
                Your people, your agents, your projects —<br />
                all in one place.
              </p>
              {error ? (
                <p className="mt-4 text-sm text-destructive">{error}</p>
              ) : null}
              <div className="mt-10 flex flex-col items-center gap-3">
                {/*
                  THE SIGN-IN — the vclaw build's PRIMARY action, FIRST in DOM order, and (with the
                  gate on) the ONLY forward control on this screen. It completes by itself: the IdP,
                  then the device key the Rust layer already holds, then the estate community, then
                  the link. The community-setup screen offers the same action from the same module
                  (`vclawSignIn.ts`), so the sequence exists once rather than twice.

                  HISTORY, KEPT: `vclaw_oidc_login` was implemented and compiled into the app but
                  had ZERO call sites in the front-end, so the IdP could not be exercised from the UI
                  at all (measured 2026-09-29). This entry point is what exercises the issuer, client,
                  redirect and scopes the Rust layer carries — and now it is the only way forward.
                  A vclaw SEGMENT IS A BUZZ COMMUNITY, so the provisioning happens here from the
                  groups the IdP returns, against the estate's own relay: the operator never sees a
                  community picker, and nothing is offered by the vendor's hosted cloud.
                */}
                <VclawOrgField
                  onSignIn={(org) => void signInWithVclawAndContinue(org)}
                  pending={isVclawPending}
                >
                  {/* THE ESTATE'S ANSWER TO THE ORG — ONE org, the group the estate itself names,
                      and BOTH whenever the answer is not textually what was entered. NOT a list of
                      the identity's other segments: `data-testid="vclaw-org-verdict"` is the only
                      place any segment name is rendered on this screen. */}
                  {/* THE ESTATE'S ANSWER TO THE ORG — ONE org, the group the estate itself names,
                      and BOTH whenever the answer is not textually what was entered. NOT a list of
                      the identity's other segments: `data-testid="vclaw-org-verdict"` is the only
                      place any org name is rendered on this screen, and a STOP is rendered here
                      too, so the reason is stated ONCE. */}
                  {vclawOrg ? (
                    <p
                      className={
                        vclawOrg.status === "not-granted"
                          ? "break-words text-xs leading-5 text-destructive"
                          : "break-words text-xs leading-5 text-muted-foreground"
                      }
                      data-status={vclawOrg.status}
                      data-testid="vclaw-org-verdict"
                    >
                      {vclawOrg.message}
                    </p>
                  ) : null}
                  {vclawResult ? (
                    <p className="break-words text-xs leading-5 text-muted-foreground">
                      {vclawResult}
                    </p>
                  ) : null}
                  {/* THE LINK, MADE VISIBLE. Design B: this device keeps its OWN Nostr key and the
                      vclaw subject is recorded beside it. Shown, not merged, so the operator can see
                      which identity the key will belong to. */}
                  {vclawAccount ? (
                    <p
                      className="break-words text-xs leading-5 text-muted-foreground"
                      data-testid="vclaw-linked-subject"
                    >
                      Linked vclaw identity: {vclawAccount.subject}
                      {vclawAccount.email ? ` (${vclawAccount.email})` : ""} —
                      this device keeps its own key; the two are recorded
                      together, not derived from one another.
                    </p>
                  ) : null}
                  {/* ONE COMMUNITY. Segments are NOT communities: the app is single-community and a
                      switch reconnects the relay and re-keys the whole tree. This reports the outcome
                      rather than asserting it. The identity's OTHER tenant groups are deliberately
                      NOT listed here: the org the estate granted is shown above, alone. */}
                  {vclawProvision ? (
                    <p
                      className="break-words text-xs leading-5 text-muted-foreground"
                      data-testid="vclaw-provisioned-community"
                    >
                      {vclawProvision.error
                        ? `Community: ${vclawProvision.error}.`
                        : `Community ${VCLAW_RELAY_URL} ` +
                          (vclawProvision.added
                            ? "added."
                            : vclawProvision.existing
                              ? "already present."
                              : "not added.")}
                    </p>
                  ) : null}
                </VclawOrgField>
                {/* VCLAW-SIGN-IN-ONLY HIDDEN — the upstream login methods, and the ONE marker for
                    them in this file.
                    WHAT: "Create a new identity key" / "Continue setup" (primary → identity-key-intro)
                    and "Use an existing key" / "Use a different key instead" (ghost → key-import).
                    WHY: operator directive 2026-10-03 — "VClaw sign-in is the DEFAULT and THE ONLY
                    method". These two ARE the upstream defaults, and the first one is the step the
                    operator was made to walk: it asks a human to create, then handle, a private key.
                    UNREACHABLE, NOT MERELY INVISIBLE: not rendered here, AND refused by the gate
                    (VCLAW_SIGN_IN_ONLY, read in `vclawSignInOnlyRefusesPage`) at the initial-page
                    normaliser and at `showPage`, so no card, resumed page, deep link or future
                    caller can land on either page.
                    RESTORE: set `VCLAW_SIGN_IN_ONLY` false at the top of this file; both buttons and
                    every page they open are intact in source. */}
                {VCLAW_SIGN_IN_ONLY ? null : (
                  <>
                    <Button
                      className={ONBOARDING_LANDING_CTA_CLASS}
                      disabled={isPending}
                      onClick={() => {
                        if (selectedPubkey) {
                          void loadFreshIdentity();
                          return;
                        }
                        showPage("identity-key-intro", "forward");
                      }}
                      type="button"
                    >
                      {isPending
                        ? "Loading identity…"
                        : selectedPubkey
                          ? "Continue setup"
                          : "Create a new identity key"}
                    </Button>
                    <Button
                      className={`${ONBOARDING_SECONDARY_CTA_CLASS} px-5`}
                      disabled={isPending}
                      onClick={() => {
                        setKeyImportDialog(null);
                        setKeyImportStage("key-entry");
                        showPage("key-import", "forward");
                      }}
                      type="button"
                      variant="ghost"
                    >
                      {selectedPubkey
                        ? "Use a different key instead"
                        : "Use an existing key"}
                    </Button>
                  </>
                )}
              </div>
              {/* Gated with the sign-in-only gate above: the key-help surface belongs to the
                  create-a-key step, which is hidden, so nothing may open it. Same constant, one
                  more read of the same helper — no second switch. */}
              {VCLAW_SIGN_IN_ONLY ? null : (
                <IdentityKeyHelpDialog
                  onOpen={() => {
                    setIdentityKeyHelpReturnPage("identity");
                    showPage("identity-key-help", "forward");
                  }}
                />
              )}
            </OnboardingSlideTransition>
          </div>
        </OnboardingFooterProvider>
      </div>
    );
  }

  return (
    <OnboardingCard
      backAction={chromeBackAction}
      current={page === "config" ? 4 : page === "setup" ? 3 : 2}
      showStepIndicator={page !== "identity-key-help"}
      testId="machine-onboarding-gate"
    >
      {page === "identity-key-intro" ? (
        <IdentityKeyIntroduction
          direction={transitionDirection}
          disabled={isPending}
          error={error}
          onCreate={() => void loadFreshIdentity()}
          onOpenHelp={() => {
            setError(null);
            setIdentityKeyHelpReturnPage("identity-key-intro");
            showPage("identity-key-help", "forward");
          }}
        />
      ) : page === "identity-key-help" ? (
        <OnboardingSlideTransition
          className="flex min-h-0 w-full flex-col items-stretch justify-start text-left"
          direction={transitionDirection}
          transitionKey={`identity-key-help-${transitionDirection}`}
        >
          <IdentityKeyHelpContent />
        </OnboardingSlideTransition>
      ) : page === "key-import" ? (
        <OnboardingSlideTransition
          className="flex min-h-0 w-full flex-col items-stretch text-left"
          direction={transitionDirection}
          transitionKey={`machine-key-import-${keyImportDialog ?? "key"}-${transitionDirection}`}
        >
          {keyImportDialog === "backup" ? (
            <div className="w-full" data-testid="backup-recovery-dialog">
              <h1 className="text-title font-normal text-foreground">
                Restore from a backup file
              </h1>
              <p className="mt-2 w-full text-base leading-6 text-foreground/80">
                Choose the encrypted backup file you saved from Buzz.
              </p>
              <NostrKeyImportForm
                key={keyImportFormKey}
                mode="backup"
                onBack={backFromKeyImport}
                onImport={importExistingIdentity}
                onImportingChange={setIsKeyImporting}
                onStageChange={setKeyImportStage}
                showBack={false}
                showPasswordStageBack={false}
                variant="spotlight"
              />
            </div>
          ) : keyImportDialog === "phone" ? (
            <div
              className="flex min-h-0 w-full flex-1 flex-col"
              data-testid="phone-recovery-dialog"
            >
              <h1 className="text-title font-normal text-foreground">
                {identityLost ? "Recover from your phone" : "Scan to sign in"}
              </h1>
              <p className="mt-2 w-full text-base leading-6 text-foreground/80">
                {phoneRecoveryStep === "loading" || phoneRecoveryStep === "qr"
                  ? "Scan this code with a device where you’re currently signed in to Buzz."
                  : "Confirm the code before sharing your identity."}
              </p>
              <div
                className="flex min-h-0 flex-1 items-center justify-center"
                data-testid="identity-recovery-stage"
              >
                <IdentityRecoveryPairing
                  onRecovered={loadRecoveredIdentity}
                  onStepChange={setPhoneRecoveryStep}
                />
              </div>
            </div>
          ) : (
            <>
              <motion.div
                animate={{ opacity: 1 }}
                className="relative z-10 shrink-0 text-left"
                initial={reduceMotion ? false : { opacity: 0 }}
                key={keyImportStage}
                transition={{
                  duration: reduceMotion ? 0 : 0.3,
                  ease: "easeOut",
                }}
              >
                <h1 className="text-title font-normal text-foreground">
                  {keyImportStage === "backup-password"
                    ? "Unlock your account"
                    : "Enter your private key"}
                </h1>
                <div className="mt-2 w-full text-base leading-6 text-foreground/80">
                  {keyImportStage === "backup-password" ? (
                    "Enter your backup password to restore your identity."
                  ) : (
                    <p>
                      Paste your private key to sign in to Buzz. You can also
                      use a{" "}
                      <button
                        className="rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
                        data-testid="nostr-import-file-button"
                        disabled={isPending || isKeyImporting}
                        onClick={() => {
                          setKeyImportStage("key-entry");
                          setKeyImportDialog("backup");
                        }}
                        type="button"
                      >
                        backup file
                      </button>
                      , or{" "}
                      <button
                        className="rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
                        data-testid="nostr-import-phone-link"
                        disabled={isPending || isKeyImporting}
                        onClick={() => {
                          setPhoneRecoveryStep("loading");
                          setKeyImportDialog("phone");
                        }}
                        type="button"
                      >
                        recover from your phone
                      </button>
                      .
                    </p>
                  )}
                </div>
              </motion.div>
              <div className="mt-8 w-full">
                <div className="flex flex-col items-stretch">
                  <NostrKeyImportForm
                    key={keyImportFormKey}
                    onBack={backFromKeyImport}
                    onImport={importExistingIdentity}
                    onImportingChange={setIsKeyImporting}
                    onStageChange={setKeyImportStage}
                    showBack={false}
                    showPasswordStageBack={false}
                    variant="spotlight"
                  />
                  {identityLost && keyImportStage === "key-entry" ? (
                    <Button
                      className={`${ONBOARDING_SECONDARY_CTA_CLASS} mt-2 px-5`}
                      disabled={isPending || isKeyImporting}
                      onClick={() => void replaceLostIdentity()}
                      type="button"
                      variant="ghost"
                    >
                      Start new identity
                    </Button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </OnboardingSlideTransition>
      ) : page === "backup" ? (
        backupSubview === "password" ? (
          <DownloadKeyStep
            direction={backupDirection}
            onBack={backFromPasswordBackup}
            session={backupSession}
          />
        ) : (
          <BackupStep
            direction={backupDirection}
            identityStorage={identityStorage}
            onNext={() => {
              showPage("setup", "forward");
            }}
            onOpenPasswordBackup={() => {
              resetEncryptedBackupSession(backupSession);
              setBackupDirection("forward");
              setReturningFromSecurity(false);
              setBackupSubview("password");
            }}
            optionsExpanded={false}
            returningFromSecurity={returningFromSecurity}
          />
        )
      ) : page === "setup" ? (
        <SetupStep
          actions={{
            // Fresh-key users return to whichever identity backup subview
            // they used to reach setup; imported keys skip backup entirely.
            back: () => {
              backFromSetup();
            },
            next: (runtimeIds, nextConfigBackTarget = "list") => {
              const ids = Array.from(runtimeIds);
              setupSelectionHandoffRef.current = ids.length > 0;
              setReadyRuntimeIds(ids);
              // Harness install can fail (Windows/PATH/network). Don't soft-lock
              // onboarding — users can finish setup later in Settings → Agents.
              if (ids.length === 0) {
                complete(selectedPubkey ?? undefined, {
                  continueToProfile: !identityWasImported,
                });
                return;
              }
              setConfigBackTarget(nextConfigBackTarget);
              setIsChoosingDifferentHarness(false);
              showPage("config", "forward");
            },
          }}
          direction={transitionDirection}
          initialMethod={harnessConnectionMethod}
          onInitialListBack={
            isChoosingDifferentHarness ? returnToApiConfig : undefined
          }
          onBackActionChange={handleSetupBackActionChange}
          onMethodChange={setHarnessConnectionMethod}
          onReadyRuntimeIdsChange={handleReadyRuntimeIdsChange}
        />
      ) : (
        <DefaultConfigStep
          actions={{
            back: () => {
              backFromConfig();
            },
            complete: () =>
              complete(selectedPubkey ?? undefined, {
                continueToProfile: !identityWasImported,
              }),
            discardDraft: () => setDefaultConfigDraft(null),
            updateDraft: setDefaultConfigDraft,
            useDifferentHarness:
              harnessConnectionMethod === "api"
                ? () => {
                    setIsChoosingDifferentHarness(true);
                    showPage("setup", "forward");
                  }
                : undefined,
          }}
          direction={transitionDirection}
          draft={defaultConfigDraft}
          onSavingChange={setIsDefaultConfigSaving}
          readyRuntimeIds={readyRuntimeIds}
        />
      )}
    </OnboardingCard>
  );
}
