import { useMyRelayMembershipLookupQuery } from "@/features/community-members/hooks";
import { canManageCommunityMembers } from "@/shared/api/relayMembers";

/**
 * Create-channel gating — CHANNELS ALPHA §5 (D3), ruled 2026-10-06:
 * create is SEGMENT-ADMIN only; non-admins get no create affordance (hidden,
 * with a marker — the backend refuses a direct API attempt regardless).
 *
 * ⚠ HOW THE CLIENT LEARNS "ADMIN" (updated 2026-10-07, lane chan-caps): the
 * admin signal is still the relay membership snapshot — NIP-43 kind:13534
 * (`useMyRelayMembershipLookupQuery`), `role === "owner" || "admin"`. What
 * changed is the SNAPSHOT'S SOURCE: the Go gateway now AUTHORS a 13534 from
 * the segment-admin union reader (CHANNELS_SERVICE_ACL §2, RULING A(iii) —
 * the same reader that enforces 9007; buzz-gateway/internal/api/
 * membership_snapshot.go), on BOTH doors the client reads: the WS REQ
 * intercept and POST /query. Before that, the gateway never authored one, so
 * on the channels estate every 13534 read answered nothing and NOBODY saw
 * create. The fork's Rust relay keeps authoring its own 13534 from its
 * relay_members table (per-community roles, unchanged this lane).
 * Residuals, named:
 *   1. A relay that publishes NO snapshot still gates this to false for
 *      everybody — D3-compliant (no non-admin affordance) at the cost of the
 *      affordance for real admins; the client renders the D3 marker state,
 *      never a lie.
 *   2. The same snapshot feeds member management (SettingsView) and the join
 *      alerts; on a gateway that admits 13534 but refuses 9030-9032 those
 *      surfaces render affordances the server will not honour — a PRE-EXISTING
 *      coupling of the one admin gate, out of scope here.
 *   3. The relay is the authority either way: a hidden button is presentation,
 *      never enforcement.
 */
export function useCanCreateChannels(): boolean {
  const lookupQuery = useMyRelayMembershipLookupQuery();
  return canManageCommunityMembers(lookupQuery.data);
}
