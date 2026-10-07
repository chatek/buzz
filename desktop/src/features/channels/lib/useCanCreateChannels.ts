import { useMyRelayMembershipLookupQuery } from "@/features/community-members/hooks";
import { canManageCommunityMembers } from "@/shared/api/relayMembers";

/**
 * Create-channel gating — CHANNELS ALPHA §5 (D3), ruled 2026-10-06:
 * create is SEGMENT-ADMIN only; non-admins get no create affordance (hidden,
 * with a marker — the backend refuses a direct API attempt regardless).
 *
 * ⚠ HOW THE CLIENT LEARNS "ADMIN" TODAY, AND ITS LIMITS (measured, do not
 * paper over): the only admin signal the desktop client has is the relay
 * membership snapshot — NIP-43 kind:13534 (`useMyRelayMembershipLookupQuery`),
 * where `role === "owner" || "admin"` is already the client's admin gate for
 * member management and the moderation queue. Whether THAT role is the same
 * fact the channels registry enforces as "segment admin" is UNKNOWN to this
 * client: nothing in the fork wires the registry's segment-admin fact into
 * kind:13534. Two consequences, accepted deliberately:
 *   1. On relays that do not publish kind:13534 the snapshot is absent, this
 *      gate reads "not admin", and NOBODY sees a create affordance — the UI
 *      stays D3-compliant (no non-admin affordance) at the cost of the
 *      affordance for real admins until the segment fact reaches the client.
 *   2. The relay is the authority either way: a hidden button is presentation,
 *      never enforcement.
 */
export function useCanCreateChannels(): boolean {
  const lookupQuery = useMyRelayMembershipLookupQuery();
  return canManageCommunityMembers(lookupQuery.data);
}
