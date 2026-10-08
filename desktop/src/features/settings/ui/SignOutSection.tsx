import * as React from "react";
import { toast } from "sonner";

import { copyNsecToClipboard, signOut } from "@/shared/api/tauriIdentity";
import { vclawSignOut } from "@/shared/api/vclawOidc";
import { useCommunities } from "@/features/communities/useCommunities";
import { leaveEveryCommunity } from "@/features/communities/leaveCommunity";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import {
  describeVclawSignOut,
  isRevocationUnresolved,
} from "../lib/vclawSignOutCopy";
import { SettingsOptionGroup, SettingsOptionRow } from "./SettingsOptionGroup";

/**
 * The exact phrase the user must type before the destructive delete button
 * unlocks. Kept lowercase; the comparison trims and lowercases input so a
 * stray capital or trailing space does not trip people up — the friction is
 * deliberate typing, not case sensitivity.
 */
export const SIGNOUT_CONFIRM_PHRASE = "wipe all my data";

/** Said after every sign-out, because it is what makes this button the safe one. */
export const IDENTITY_UNTOUCHED_COPY =
  "Your identity key and local data are untouched.";

/**
 * ⚠ THE COMMUNITIES ARE LEFT, AND THAT IS A DELIBERATE CHANGE (operator request, 2026-10-04).
 *
 * The request, verbatim: *"I clicked 'Signout' but it shall also mean 'Leave community' or leave
 * any logged in communities on VClawBuzz."*
 *
 * WHAT IT REPLACES: the paragraph above this section said *"the relay session and every local byte
 * stay exactly where they are"* - so signing out left the device joined to every community it had
 * joined. The session went; the memberships did not. **A sign-out that leaves you in the rooms is
 * not a sign-out, and the next person to open the app found themselves back inside.**
 *
 * WHAT IS AND IS NOT CLEARED: the community LIST and its navigation state are cleared, so the app
 * forgets which relays this device belonged to. The identity key, the keyring and the local database
 * still stay - this is still the non-destructive action, and `Delete my data` remains the only
 * destructive one. **Leaving a community is not destroying the identity that joined it.**
 */
export const COMMUNITIES_LEFT_COPY =
  "This device has also left the community or communities it had joined.";

/**
 * The community half of a sign-out, stated honestly: the promise in
 * [`COMMUNITIES_LEFT_COPY`] is only true when every leave was accepted. A
 * refused or timed-out leave is a WARNING, never a silent success.
 */
export function describeCommunityLeaveOutcomes(
  total: number,
  failed: number,
): string {
  if (failed === 0) return COMMUNITIES_LEFT_COPY;
  if (failed === total) {
    return total === 1
      ? "This device could not be confirmed as having left its community — it may still be a member on the relay."
      : `This device could not be confirmed as having left any of its ${total} communities — it may still be a member on those relays.`;
  }
  return `This device left ${total - failed} of ${total} communities, but could not leave ${failed} — it may still be a member there.`;
}

/**
 * TWO actions, and they must never collapse into one again.
 *
 * ── WHAT WAS WRONG (operator question, 2026-10-03) ─────────────────────────────
 * This section was titled "Sign out" and its only action was `Delete my data`:
 * a destructive button, gated behind a typed "wipe all my data", that removes
 * the identity key and all local state and relaunches into first-run setup. A
 * user who merely wanted to log out had to destroy their identity, or stay
 * signed in. The title promised a sign-out the section did not offer, and the
 * only way to end a session was the one action nobody should have to take.
 *
 * Now there are two:
 *
 * 1. **Sign out** — non-destructive. Clears the cached vclaw session, asks the IdP
 *    to revoke the refresh token it issued (RFC 7009), **and leaves the community or
 *    communities this device had joined** (operator request, 2026-10-04 - see
 *    `COMMUNITIES_LEFT_COPY`). The identity key, the keyring and the local database
 *    stay exactly where they are; the MEMBERSHIPS do not.
 * 2. **Delete my data** — unchanged, and still the only destructive action here:
 *    key + all local data + relaunch into first-run setup, behind two explicit
 *    gates (a tested backup confirmation and the typed phrase).
 *
 * The order is deliberate: the safe action is the one the eye reaches first, and
 * the destructive button keeps the confirmation flow it always had.
 *
 * One limitation is stated in the UI rather than papered over: the IdP
 * advertises no `end_session_endpoint`, so signing out here does NOT close the
 * browser session at auth.vclawhub.com. That cookie lives in whatever browser
 * ran the sign-in, and it is how a different identity reached this app during
 * the operator's walk — so the copy tells the user to sign out there on a shared
 * machine.
 */
export function SignOutSection() {
  // ⚠ THE SHARED CONTEXT, not a second instance: `useCommunities` reads `CommunitiesContext`, so
  // clearing here clears the SAME list the rest of the app renders from, and leaving here leaves
  // the SAME communities the rail is showing.
  const { communities, activeCommunity, clearCommunities } = useCommunities();

  // ── Non-destructive: the vclaw session ──────────────────────────────────────
  const [isVclawPending, setIsVclawPending] = React.useState(false);

  // ── Destructive: the local wipe (unchanged flow) ────────────────────────────
  const [isOpen, setIsOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);

  // Backup gate.
  const [copyState, setCopyState] = React.useState<
    "idle" | "copying" | "copied"
  >("idle");
  const [nsecError, setNsecError] = React.useState<string | null>(null);
  const [hasConfirmedBackup, setHasConfirmedBackup] = React.useState(false);

  // Typed-confirmation gate.
  const [confirmText, setConfirmText] = React.useState("");
  const isPhraseConfirmed =
    confirmText.trim().toLowerCase() === SIGNOUT_CONFIRM_PHRASE;

  const canDelete = hasConfirmedBackup && isPhraseConfirmed && !isPending;

  function resetDialogState() {
    setCopyState("idle");
    setNsecError(null);
    setHasConfirmedBackup(false);
    setConfirmText("");
  }

  function openDialog() {
    setIsOpen(true);
    setCopyState("idle");
    setNsecError(null);
  }

  /**
   * Copy the private key WITHOUT it ever being held in React state. The
   * clipboard write happens in Rust (`copy_nsec_to_clipboard`), which is the
   * whole point: the renderer that shows remote message content must not hold
   * the full nsec (key-lifecycle audit #5).
   */
  async function handleCopyNsec() {
    setCopyState("copying");
    setNsecError(null);
    try {
      await copyNsecToClipboard();
      setCopyState("copied");
    } catch (err) {
      setCopyState("idle");
      setNsecError(
        err instanceof Error ? err.message : "Failed to copy private key.",
      );
    }
  }

  /**
   * Sign out of vclaw: the small action.
   *
   * Nothing here reads, clears, or moves the identity key. The IdP revocation
   * and the per-community relay leaves are reported honestly: a sign-out whose
   * revocation or leave was refused or never sent is a warning, not a success,
   * because the credential is then still live.
   */
  async function handleVclawSignOut() {
    setIsVclawPending(true);
    try {
      const report = await vclawSignOut();
      // ⚠ LEAVING THE COMMUNITIES IS PART OF SIGNING OUT (operator request, 2026-10-04):
      // *"I clicked 'Signout' but it shall also mean 'Leave community' or leave any logged in
      // communities on VClawBuzz."* Every held community is left BEFORE the local clear, and a
      // refused/timed-out leave is COLLECTED rather than thrown, so the local clear still runs
      // after the revocation attempt and after the leaves — a live refresh token or a live
      // membership must not survive because a list failed to empty (mirrors the existing
      // revocation-before-clear ordering comment).
      const leaveOutcomes = await leaveEveryCommunity(
        communities,
        activeCommunity?.relayUrl,
      );
      clearCommunities();
      const failedLeaves = leaveOutcomes.filter(
        (outcome) => outcome.status === "failed",
      ).length;
      const description = `${describeVclawSignOut(report)} ${IDENTITY_UNTOUCHED_COPY} ${describeCommunityLeaveOutcomes(leaveOutcomes.length, failedLeaves)}`;
      if (isRevocationUnresolved(report) || failedLeaves > 0) {
        const title =
          isRevocationUnresolved(report) && failedLeaves > 0
            ? "Signed out on this device — the IdP was not updated and some communities were not left."
            : isRevocationUnresolved(report)
              ? "Signed out on this device — the IdP was not updated."
              : "Signed out on this device — some communities were not left.";
        toast.warning(title, { description });
      } else {
        toast.success("Signed out of vclaw.", { description });
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not sign out of vclaw.",
      );
    } finally {
      setIsVclawPending(false);
    }
  }

  function handleSignOut() {
    setIsPending(true);
    // Keep the pending state if signOut() resolves before restart.
    signOut()
      .then(() => {
        // Clear web storage for this origin on the success path only. This
        // covers dev builds where the Rust webview wipe targets the
        // .app-bundle WebKit dir (missing in `tauri dev`), preventing stale
        // community config from vouching for the fresh key on next boot. In
        // production the Rust wipe already handles this; the clear here is
        // redundant but harmless. The restart may race this clear — that is
        // acceptable; Fix A (pubkey-scoped heuristic) is the correctness
        // gate.
        window.localStorage.clear();
        window.sessionStorage.clear();
      })
      .catch((err: unknown) => {
        setIsPending(false);
        setIsOpen(false);
        resetDialogState();
        toast.error(err instanceof Error ? err.message : "Sign out failed.");
      });
  }

  return (
    <div className="mt-12 space-y-12 pb-6" data-testid="settings-signout">
      <SettingsOptionGroup data-testid="signout-vclaw-group" title="Sign out">
        <SettingsOptionRow>
          <div className="min-w-0">
            <p
              className="text-sm font-normal text-muted-foreground/70"
              data-settings-subcopy
            >
              Signs you out of vclaw on this device, and asks the IdP to revoke
              the refresh token it issued. Your identity key and all local app
              data stay where they are.
            </p>
          </div>
          <Button
            data-testid="signout-vclaw"
            disabled={isVclawPending}
            onClick={() => void handleVclawSignOut()}
            type="button"
          >
            {isVclawPending ? (
              <Spinner aria-label="Signing out" className="h-4 w-4 border-2" />
            ) : null}
            {isVclawPending ? "Signing out…" : "Sign out"}
          </Button>
        </SettingsOptionRow>
        {/* The one part of a logout this app cannot do for the user: no
            `end_session_endpoint` exists on this IdP, so the browser cookie
            survives. Stated, not implied. */}
        <div className="px-4 py-3" data-testid="signout-browser-session-note">
          <p
            className="text-xs font-normal text-muted-foreground/70"
            data-settings-subcopy
          >
            This does not end the browser session at auth.vclawhub.com — the IdP
            advertises no end-session endpoint, so that sign-in cookie stays in
            whichever browser you used. On a shared or borrowed machine, sign
            out there too.
          </p>
        </div>
      </SettingsOptionGroup>

      <SettingsOptionGroup
        data-testid="signout-delete-group"
        title="Delete my data"
      >
        <SettingsOptionRow>
          <div className="min-w-0">
            <p
              className="text-sm font-normal text-muted-foreground/70"
              data-settings-subcopy
            >
              Deletes your identity key and all local app data from this device,
              then relaunches Buzz into first-run setup. Create and test a
              password-protected key backup above first — this cannot be undone.
            </p>
          </div>
          <Button
            data-testid="signout-open-dialog"
            disabled={isPending}
            onClick={() => void openDialog()}
            type="button"
            variant="destructive"
          >
            {isPending ? (
              <Spinner aria-label="Signing out" className="h-4 w-4 border-2" />
            ) : null}
            {isPending ? "Signing out…" : "Delete my data"}
          </Button>
        </SettingsOptionRow>
      </SettingsOptionGroup>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !isPending) {
            setIsOpen(false);
            resetDialogState();
          }
        }}
        open={isOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete your identity key and all data?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will delete your identity key, all agent settings, and cached
              data from this device, then relaunch Buzz into first-run setup.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <p className="text-sm font-medium">
              1. Confirm you can restore your identity
            </p>
            <Button
              data-testid="signout-copy-key"
              disabled={copyState === "copying"}
              onClick={() => void handleCopyNsec()}
              type="button"
              variant="outline"
            >
              {copyState === "copying"
                ? "Copying…"
                : copyState === "copied"
                  ? "Copied to clipboard"
                  : "Copy private key"}
            </Button>
            {nsecError ? (
              <p
                className="text-sm text-destructive"
                data-testid="signout-nsec-error"
              >
                {nsecError}
              </p>
            ) : null}
            <p className="text-xs leading-5 text-muted-foreground">
              The key is copied by the desktop app — it never enters the
              settings screen itself.
            </p>
            <label
              className="flex cursor-pointer items-start gap-2.5 text-sm has-[button:disabled]:cursor-not-allowed has-[button:disabled]:opacity-60"
              data-testid="signout-backup-confirm-label"
              htmlFor="signout-backup-confirm"
            >
              <Checkbox
                checked={hasConfirmedBackup}
                className="mt-0.5"
                data-testid="signout-backup-confirm"
                disabled={isPending}
                id="signout-backup-confirm"
                onCheckedChange={(checked) =>
                  setHasConfirmedBackup(checked === true)
                }
              />
              <span>
                I have tested a key backup or saved this private key somewhere
                safe.
              </span>
            </label>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="signout-confirm-phrase"
            >
              2. Type{" "}
              <span className="font-semibold">"{SIGNOUT_CONFIRM_PHRASE}"</span>{" "}
              to confirm
            </label>
            <Input
              autoComplete="off"
              data-testid="signout-confirm-phrase"
              disabled={isPending}
              id="signout-confirm-phrase"
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={SIGNOUT_CONFIRM_PHRASE}
              spellCheck={false}
              value={confirmText}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            {/* A plain Button, not AlertDialogAction: Radix's Action closes
                the dialog on click, which would drop the pending state while
                the wipe + restart is still in flight. */}
            <Button
              data-testid="signout-confirm"
              disabled={!canDelete}
              onClick={handleSignOut}
              type="button"
              variant="destructive"
            >
              {isPending ? (
                <Spinner
                  aria-label="Signing out"
                  className="h-4 w-4 border-2"
                />
              ) : null}
              {isPending ? "Signing out…" : "Delete my data"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
