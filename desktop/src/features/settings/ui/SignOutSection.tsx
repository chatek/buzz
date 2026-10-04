import * as React from "react";
import { toast } from "sonner";

import { NsecMaskedDisplay } from "@/features/onboarding/ui/NsecMaskedDisplay";
import { getNsec, signOut } from "@/shared/api/tauriIdentity";
import { vclawSignOut } from "@/shared/api/vclawOidc";
import { useCommunities } from "@/features/communities/useCommunities";
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
  // clearing here clears the SAME list the rest of the app renders from.
  const { clearCommunities } = useCommunities();

  // ── Non-destructive: the vclaw session ──────────────────────────────────────
  const [isVclawPending, setIsVclawPending] = React.useState(false);

  // ── Destructive: the local wipe (unchanged flow) ────────────────────────────
  const [isOpen, setIsOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);

  // Backup gate.
  const [nsec, setNsec] = React.useState<string | null>(null);
  const [nsecError, setNsecError] = React.useState<string | null>(null);
  const [isNsecLoading, setIsNsecLoading] = React.useState(false);
  const [hasConfirmedBackup, setHasConfirmedBackup] = React.useState(false);
  // Guards against a late-resolving getNsec() repopulating state after the
  // dialog closes.
  const fetchCancelledRef = React.useRef(false);

  // Typed-confirmation gate.
  const [confirmText, setConfirmText] = React.useState("");
  const isPhraseConfirmed =
    confirmText.trim().toLowerCase() === SIGNOUT_CONFIRM_PHRASE;

  const canDelete = hasConfirmedBackup && isPhraseConfirmed && !isPending;

  function resetDialogState() {
    fetchCancelledRef.current = true;
    setNsec(null);
    setNsecError(null);
    setIsNsecLoading(false);
    setHasConfirmedBackup(false);
    setConfirmText("");
  }

  React.useEffect(() => {
    return () => {
      fetchCancelledRef.current = true;
      setNsec(null);
    };
  }, []);

  async function openDialog() {
    setIsOpen(true);
    fetchCancelledRef.current = false;
    setIsNsecLoading(true);
    setNsecError(null);
    try {
      const value = await getNsec();
      if (!fetchCancelledRef.current) setNsec(value);
    } catch (err) {
      if (!fetchCancelledRef.current)
        setNsecError(
          err instanceof Error
            ? err.message
            : "Failed to retrieve private key.",
        );
    } finally {
      if (!fetchCancelledRef.current) setIsNsecLoading(false);
    }
  }

  /**
   * Sign out of vclaw: the small action.
   *
   * Nothing here reads, clears, or moves the identity key — the one command it
   * crosses the boundary with is `vclaw_oidc_sign_out`, which owns the cached
   * vclaw credential and nothing else. The verdict is reported honestly: a
   * sign-out whose revocation was refused or never sent is a warning, not a
   * success, because the refresh token is then still live.
   */
  async function handleVclawSignOut() {
    setIsVclawPending(true);
    try {
      const report = await vclawSignOut();
      // ⚠ LEAVING THE COMMUNITIES IS PART OF SIGNING OUT (operator request, 2026-10-04):
      // *"I clicked 'Signout' but it shall also mean 'Leave community' or leave any logged in
      // communities on VClawBuzz."* Clearing AFTER the revocation attempt, so the IdP call still
      // happens even if the local clear throws - a live refresh token must not survive because a
      // list failed to empty.
      clearCommunities();
      const description = `${describeVclawSignOut(report)} ${IDENTITY_UNTOUCHED_COPY} ${COMMUNITIES_LEFT_COPY}`;
      if (isRevocationUnresolved(report)) {
        toast.warning("Signed out on this device — the IdP was not updated.", {
          description,
        });
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
            {isNsecLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : nsecError ? (
              <p
                className="text-sm text-destructive"
                data-testid="signout-nsec-error"
              >
                {nsecError}
              </p>
            ) : nsec ? (
              <NsecMaskedDisplay nsec={nsec} />
            ) : null}
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
