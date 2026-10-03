import type { VclawSignOutReport } from "@/shared/api/vclawOidc";

/**
 * What the user is told after a vclaw sign-out, in one sentence per verdict.
 *
 * WHY THIS IS A FUNCTION AND NOT A STRING IN THE COMPONENT (operator question,
 * 2026-10-03): a sign-out has two outcomes that look identical on screen and are
 * not — the cached session is gone locally either way, while the refresh token
 * is either revoked at the IdP or still live. A single "Signed out." message is
 * therefore wrong in four of the five verdicts below, and the one that matters
 * (`rejected`/`unreachable`) is the one where a user might walk away from a
 * borrowed machine believing the credential is dead.
 */
export function describeVclawSignOut(report: VclawSignOutReport): string {
  const status =
    report.revocationStatus === null
      ? ""
      : ` (HTTP ${report.revocationStatus})`;
  switch (report.revocation) {
    case "revoked":
      // "Accepted the revocation", not "revoked just now": the live endpoint
      // answers 200 for a token it has never seen as well as for one it just
      // killed (MEASURED 2026-10-03; see VCLAW_REVOCATION_URL in vclaw_oidc.rs).
      // What the user needs is the consequence, which 200 does establish — the
      // token is not usable.
      return report.hadCachedToken
        ? "Your vclaw session is cleared on this device, and the IdP accepted the revocation of the refresh token. It cannot be used again."
        : "The IdP accepted the revocation. There was no cached vclaw session on this device.";
    case "no_cached_token":
      return "There was no cached vclaw session on this device, so there was nothing to revoke.";
    case "rejected":
      return `Signed out on this device, but the vclaw IdP refused to revoke the refresh token${status}. Treat it as usable until it expires.`;
    case "unreachable":
      return `Signed out on this device, but the vclaw IdP could not be reached${status}, so the refresh token was not revoked.`;
    case "cache_unreadable":
      return "Signed out on this device, but the cached token could not be read, so no revocation was sent to the IdP.";
    default:
      return `Signed out on this device. The IdP's revocation answer was not recognised (${String(
        report.revocation,
      )}${status}), so treat the refresh token as unrevoked.`;
  }
}

/**
 * True when the verdict leaves the refresh token usable, so the toast must read
 * as a warning rather than a success.
 *
 * A local sign-out that reports a clean success while the credential is still
 * live is the exact failure this feature exists to remove.
 */
export function isRevocationUnresolved(report: VclawSignOutReport): boolean {
  return (
    report.revocation === "rejected" ||
    report.revocation === "unreachable" ||
    report.revocation === "cache_unreadable"
  );
}
