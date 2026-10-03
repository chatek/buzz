import * as React from "react";
import { Check, Copy } from "lucide-react";

import { HostedCommunityOnboarding } from "@/features/communities/ui/HostedCommunityOnboarding";
import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import { InviteRedeemForm } from "@/features/onboarding/ui/InviteRedeemForm";
import { OnboardingChrome } from "@/features/onboarding/ui/OnboardingChrome";
import { OnboardingFooterProvider } from "@/features/onboarding/ui/OnboardingFooter";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "@/features/onboarding/ui/OnboardingSlideTransition";
import { useIdentityQuery } from "@/shared/api/hooks";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { pubkeyToNpub } from "@/shared/lib/nostrUtils";
import { useSystemColorScheme } from "@/shared/theme/useSystemColorScheme";
import { useCommunities } from "@/features/communities/useCommunities";
import { VCLAW_RELAY_URL } from "@/features/onboarding/vclawCommunityProvision";
import {
  describeVclawSignInFailure,
  signInWithVclaw,
  VclawSignInFailure,
} from "@/features/onboarding/vclawSignIn";
import type { OrgVerdict } from "@/features/onboarding/vclawOrg";
import { VclawOrgField } from "@/features/onboarding/ui/VclawOrgField";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

type WelcomeSetupPage = "welcome" | "existing" | "join" | "member" | "owned";
type WelcomeTransitionMode = "initial" | OnboardingTransitionDirection;

type WelcomeSetupProps = {
  initialPage?: WelcomeSetupPage;
  initialTransitionMode?: WelcomeTransitionMode;
  onBack?: () => void;
};

const COMMUNITY_OPTION_CARD_CLASS =
  "w-full max-w-[320px] items-center px-6 py-4 text-center text-sm font-normal leading-6 text-foreground [--buzz-card-textured-min-height:88px] transition-[filter] duration-150 ease-out hover:brightness-[0.98] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/35";

// The community picker is a GATE, not a CSS hide — see the SPRINT-1 marker above the hidden picker
// block below for what is hidden, why, and what a later sprint must restore. This constant and the
// two guards that read it (the initial-page normaliser and showPage) are that gate.
const VCLAW_SPRINT_1_PICKER_HIDDEN = true;
const VCLAW_SPRINT_1_HIDDEN_PAGES: ReadonlySet<WelcomeSetupPage> = new Set([
  "join",
  "existing",
  "owned",
  "member",
]);

export function WelcomeSetup({
  initialPage = "welcome",
  initialTransitionMode = "initial",
  onBack,
}: WelcomeSetupProps) {
  // A resumed page (resumeFirstCommunityPage / a deep link) must not open a hidden route even
  // though nothing rendered a card for it — half of the SPRINT-1 gate.
  const [page, setPage] = React.useState<WelcomeSetupPage>(
    VCLAW_SPRINT_1_PICKER_HIDDEN && VCLAW_SPRINT_1_HIDDEN_PAGES.has(initialPage)
      ? "welcome"
      : initialPage,
  );
  const [transitionMode, setTransitionMode] =
    React.useState<WelcomeTransitionMode>(initialTransitionMode);
  // While true, the Builderlab sign-in modal floats over the current page —
  // we only navigate to the hosted stage once sign-in completes, so the page
  // behind the modal never changes out from under the user.
  const [isHostedSignInOpen, setIsHostedSignInOpen] = React.useState(false);
  const [copiedNpub, setCopiedNpub] = React.useState(false);
  const [isVclawPending, setIsVclawPending] = React.useState(false);
  const [vclawMessage, setVclawMessage] = React.useState<string | null>(null);
  // The ESTATE's answer to the org entered in the field below — shown here for the same reason as
  // on the entry screen: the claim decides, and its answer is what the human sees. `null` before a
  // sign-in and after a STOP.
  const [vclawOrg, setVclawOrg] = React.useState<OrgVerdict | null>(null);
  const communityOnboarding = useCommunityOnboarding();
  const { reloadFromStorage } = useCommunities();

  // THE SAME SIGN-IN AS THE ENTRY SCREEN, for the case where this page is reached with no
  // community: the IdP, then THE ESTATE'S ANSWER TO THE ORG (a miss stops before the community is
  // entered), then the device key the Rust layer already holds, then the estate community, then the
  // subject recorded beside the key (see `vclawSignIn.ts` — one sequence, two screens). On success the community is in storage, so `reloadFromStorage` is what turns
  // this page into the app itself, exactly as the machine-onboarding handoff does.
  //
  // WHY THIS PAGE HAS IT AT ALL: with the community picker gated, this screen used to say
  // "Use Back to sign in" and offer NO forward action — a dead end the operator reached. It is
  // not reachable in the vclaw flow (the sign-in provisions the community before the app mounts,
  // so `needsSetup` is false), but a reachable dead end is a bug whether or not it is the path
  // we expect, so the fallback is the sign-in rather than an instruction to go backwards.
  const signIn = React.useCallback(
    async (org: string) => {
      setIsVclawPending(true);
      setVclawMessage(null);
      setVclawOrg(null);
      try {
        const {
          account,
          provision,
          link,
          org: grantedOrg,
        } = await signInWithVclaw(org);
        setVclawOrg(grantedOrg);
        setVclawMessage(
          `Signed in to vclaw as ${account.subject}` +
            (provision.error
              ? ` — the estate community could not be provisioned (${provision.error}).`
              : ` — the estate community ${VCLAW_RELAY_URL} is ready.`) +
            (link
              ? ""
              : " The subject could not be recorded beside this device's key."),
        );
        reloadFromStorage();
      } catch (cause) {
        // A refusal from the ESTATE is not an IdP error, and saying so would send the reader to
        // the issuer when the claim was what said no (see the pitfall log's wrong-layer entries).
        const stopped = cause instanceof VclawSignInFailure ? cause : null;
        setVclawOrg(stopped?.verdict ?? null);
        // An ORG refusal IS the estate's answer: it renders as the verdict, once, and is not repeated
        // as a second sentence.
        setVclawMessage(
          stopped?.stage === "org" ? null : describeVclawSignInFailure(cause),
        );
      } finally {
        setIsVclawPending(false);
      }
    },
    [reloadFromStorage],
  );
  const identityQuery = useIdentityQuery();
  const systemColorScheme = useSystemColorScheme();
  const npub = identityQuery.data?.pubkey
    ? pubkeyToNpub(identityQuery.data.pubkey)
    : "";
  const npubError = identityQuery.error
    ? identityQuery.error instanceof Error
      ? identityQuery.error.message
      : "Could not load your public key."
    : null;

  const showPage = React.useCallback(
    (nextPage: WelcomeSetupPage, direction?: OnboardingTransitionDirection) => {
      // THE choke point of the SPRINT-1 gate: every card, deep link and callback routes through
      // here, so refusing the hidden pages once covers all of them.
      if (
        VCLAW_SPRINT_1_PICKER_HIDDEN &&
        VCLAW_SPRINT_1_HIDDEN_PAGES.has(nextPage)
      ) {
        return;
      }
      setTransitionMode(
        direction ?? (nextPage === "welcome" ? "backward" : "forward"),
      );
      setPage(nextPage);
    },
    [],
  );

  const startConnection = React.useCallback(
    (relayUrl: string) => {
      communityOnboarding.start({
        source: "first-community",
        firstCommunityPage: page === "member" ? "member" : "join",
        relayUrl,
      });
    },
    [communityOnboarding, page],
  );

  const redeemInvite = React.useCallback(
    (relayUrl: string, code: string, policyReceipt?: string) => {
      communityOnboarding.start({
        source: "first-community",
        firstCommunityPage: page === "member" ? "member" : "join",
        relayUrl,
        inviteCode: code,
        policyReceipt,
      });
    },
    [communityOnboarding, page],
  );

  const beginHostedCommunity = React.useCallback(
    () => setIsHostedSignInOpen(true),
    [],
  );

  const transitionDirection =
    transitionMode === "backward" ? "backward" : "forward";
  const backAction =
    page === "welcome" && onBack
      ? { onClick: onBack, testId: "welcome-setup-back" }
      : page === "existing"
        ? {
            onClick: () => showPage("welcome"),
            testId: "existing-back",
          }
        : page === "join"
          ? {
              onClick: () => showPage("welcome"),
              testId: "welcome-join-back",
            }
          : page === "member"
            ? {
                onClick: () => showPage("existing"),
                testId: "welcome-member-back",
              }
            : undefined;

  return (
    <div
      className="buzz-onboarding-neutral-theme buzz-startup-shell flex h-dvh items-start justify-center overflow-y-auto bg-background px-4 pb-36 pt-[106px] text-foreground"
      data-system-color-scheme={systemColorScheme}
      data-testid="welcome-setup"
    >
      <StartupWindowDragRegion />
      <OnboardingChrome current={5} />
      <OnboardingFooterProvider backAction={backAction}>
        <div className="relative flex min-h-0 w-full max-w-[920px] flex-1 flex-col items-center text-center">
          {page === "welcome" ? (
            <OnboardingSlideTransition
              className="flex h-full min-h-0 w-full flex-col items-center text-center"
              containerClassName="h-full min-h-0 [&>.buzz-onboarding-transition-line]:h-full"
              direction={transitionDirection}
              transitionKey={`welcome-${transitionDirection}`}
            >
              <div className="w-full max-w-[760px]">
                <h1 className="text-title font-normal">
                  {VCLAW_SPRINT_1_PICKER_HIDDEN
                    ? "Sign in to join the estate community"
                    : "Join or create a community"}
                </h1>
                <p className="mt-3 text-sm leading-6 text-foreground/80">
                  {VCLAW_SPRINT_1_PICKER_HIDDEN
                    ? "This build joins the vclaw estate's own community when you sign in with VClaw."
                    : "Join with an invite, create your own community, or reconnect one you already have."}
                </p>
              </div>
              {/* VCLAW-SPRINT-1 HIDDEN — the community picker, and the ONE marker for it in this file.
                  WHAT: the three options (Join a community / Create a community / I already have a
                  community), plus the pages they open (join, existing, owned, member — the last being
                  the raw relay-entry page).
                  WHY: Create and I-own route to the VENDOR's hosted cloud (communities.buzz.xyz) and
                  the vclaw login already provisions the estate's one community; Join shows this
                  device's public ID and asks a human owner to add it, and there is no such owner here;
                  a free-text relay entry cannot reach the estate.
                  UNREACHABLE, NOT MERELY INVISIBLE: not rendered here, AND their routes are refused by
                  the SPRINT-1 gate (VCLAW_SPRINT_1_PICKER_HIDDEN) at the initial-page normaliser and
                  at showPage, so a card, a resumed page or a future caller cannot land on them.
                  RESTORE: set the constant false; the options and pages are intact in source. */}
              {/* The vclaw action, rendered INSTEAD of the picker while the gate is on. It is
                  the only forward control on this page, and it is the same sequence as the entry
                  screen's — one module, so the two cannot drift. No second switch: this reads the
                  same VCLAW_SPRINT_1_PICKER_HIDDEN as the hidden block below. */}
              {VCLAW_SPRINT_1_PICKER_HIDDEN ? (
                <div className="flex w-full flex-1 translate-y-16 flex-col items-center justify-center gap-4 py-8">
                  {/* The SAME field and the same sign-in as the entry screen — one module, so the
                      two cannot drift. The field owns the CTA: while the org is invalid there is no
                      next step (docs/UI_INPUT_VALIDATION.md), and no list of orgs is offered. */}
                  <VclawOrgField
                    ctaTestId="welcome-vclaw-sign-in"
                    onSignIn={(org) => void signIn(org)}
                    pending={isVclawPending}
                  >
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
                    {vclawMessage ? (
                      <p className="break-words text-xs leading-5 text-muted-foreground">
                        {vclawMessage}
                      </p>
                    ) : null}
                  </VclawOrgField>
                </div>
              ) : (
                <div className="flex w-full flex-1 translate-y-16 flex-col items-center justify-center gap-20 py-8">
                  <Card
                    asChild
                    className={COMMUNITY_OPTION_CARD_CLASS}
                    variant="textured"
                  >
                    <button
                      data-testid="community-choice-join"
                      onClick={() => showPage("join")}
                      type="button"
                    >
                      Join a community
                    </button>
                  </Card>
                  <Card
                    asChild
                    className={COMMUNITY_OPTION_CARD_CLASS}
                    variant="textured"
                  >
                    <button
                      data-testid="community-choice-create"
                      onClick={beginHostedCommunity}
                      type="button"
                    >
                      Create a community
                    </button>
                  </Card>
                  <Card
                    asChild
                    className={COMMUNITY_OPTION_CARD_CLASS}
                    variant="textured"
                  >
                    <button
                      data-testid="community-choice-existing"
                      onClick={() => showPage("existing")}
                      type="button"
                    >
                      I already have a community
                    </button>
                  </Card>
                </div>
              )}
            </OnboardingSlideTransition>
          ) : page === "existing" ? (
            <OnboardingSlideTransition
              className="flex h-full min-h-0 w-full flex-col items-center text-center"
              containerClassName="h-full min-h-0 [&>.buzz-onboarding-transition-line]:h-full"
              direction={transitionDirection}
              transitionKey={`existing-${transitionDirection}`}
            >
              <div className="w-full max-w-[760px]">
                <h1 className="text-title font-normal">
                  Reconnect to your community
                </h1>
                <p className="mt-3 text-sm leading-6 text-foreground/80">
                  Tell us your role so we can find the fastest way back in.
                </p>
              </div>
              <div className="flex w-full flex-1 translate-y-16 flex-col items-center justify-center gap-20 py-8">
                <Card
                  asChild
                  className={COMMUNITY_OPTION_CARD_CLASS}
                  variant="textured"
                >
                  <button
                    data-testid="existing-choice-owner"
                    onClick={beginHostedCommunity}
                    type="button"
                  >
                    I own the community
                  </button>
                </Card>
                <Card
                  asChild
                  className={COMMUNITY_OPTION_CARD_CLASS}
                  variant="textured"
                >
                  <button
                    data-testid="existing-choice-member"
                    onClick={() => showPage("member")}
                    type="button"
                  >
                    I’m a member or admin
                  </button>
                </Card>
              </div>
            </OnboardingSlideTransition>
          ) : page === "owned" ? (
            <OnboardingSlideTransition
              className="flex w-full flex-col items-center text-center"
              direction={transitionDirection}
              transitionKey={`owned-${transitionDirection}`}
            >
              <HostedCommunityOnboarding onBack={() => showPage("welcome")} />
            </OnboardingSlideTransition>
          ) : (
            <OnboardingSlideTransition
              className="flex min-h-[calc(100dvh-15.625rem)] w-full flex-col items-center text-center"
              direction={transitionDirection}
              transitionKey={`${page}-${transitionDirection}`}
            >
              <div className="w-full max-w-[620px]">
                <h1 className="text-title font-normal">
                  {page === "member"
                    ? "Reconnect to your community"
                    : "Join a community"}
                </h1>
                <p className="mt-3 text-sm leading-6 text-foreground/80">
                  {page === "member"
                    ? "Enter the community URL or an invite link. Your role will be restored when you connect."
                    : "Enter the invite link or community URL you received."}
                </p>
              </div>
              <div className="flex w-full flex-1 flex-col items-center justify-center gap-16">
                <InviteRedeemForm
                  error={null}
                  isRedeeming={false}
                  onCancel={() =>
                    showPage(page === "member" ? "existing" : "welcome")
                  }
                  onConnect={startConnection}
                  onRedeem={redeemInvite}
                  placeholder="Invite link or community URL"
                  variant="onboarding-spotlight"
                />
                {page === "join" ? (
                  <div className="w-full max-w-[560px] text-left">
                    <p className="text-sm font-medium text-foreground">
                      Joining a private community?
                    </p>
                    <p className="mt-2 text-sm leading-6 text-foreground/75">
                      Some communities need the owner to add you before you can
                      join. Copy your public ID and send it to the community
                      owner.
                    </p>
                    <div className="mt-4 flex items-center gap-3 rounded-xl border border-foreground/10 bg-background/35 px-4 py-3">
                      <code
                        className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80"
                        data-testid="welcome-join-npub"
                      >
                        {npub || "Loading…"}
                      </code>
                      <Button
                        aria-label="Copy public ID"
                        className="h-9 shrink-0 rounded-full px-3"
                        disabled={!npub}
                        onClick={() => {
                          void writeTextToClipboard(npub).then(() => {
                            setCopiedNpub(true);
                            window.setTimeout(() => setCopiedNpub(false), 1500);
                          });
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {copiedNpub ? (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Copy className="h-4 w-4" aria-hidden="true" />
                        )}
                        <span>{copiedNpub ? "Copied" : "Copy"}</span>
                      </Button>
                    </div>
                    {npubError ? (
                      <p className="mt-3 text-sm text-destructive">
                        {npubError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </OnboardingSlideTransition>
          )}
          {isHostedSignInOpen && page !== "owned" ? (
            <HostedCommunityOnboarding
              onBack={() => setIsHostedSignInOpen(false)}
              onReady={() => {
                setIsHostedSignInOpen(false);
                showPage("owned");
              }}
              stageHidden
            />
          ) : null}
        </div>
      </OnboardingFooterProvider>
    </div>
  );
}
