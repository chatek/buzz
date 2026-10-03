import {
  loadCommunities,
  normalizeRelayUrl,
  saveActiveCommunityId,
  saveCommunities,
} from "@/features/communities/communityStorage";
import type { Community } from "@/features/communities/types";

/**
 * Provision the ONE Buzz community this estate runs on, from a vclaw login.
 *
 * ⚠️ THIS FILE WAS WRONG ONCE, AND THE CORRECTION IS THE DESIGN.
 * The first version added ONE COMMUNITY PER SEGMENT (`vchat.tenant.kuai`, `vchat.tenant.vclaw`, ...).
 * That is the wrong shape, and it was measured rather than argued:
 *
 *   · The app is NOT "an app with a community switcher". It is a SINGLE-COMMUNITY app that can be
 *     pointed at one relay at a time. Everything stateful lives under `key={communityKey}`
 *     (`src/app/App.tsx:416,640,651`), and switching communities tears down ~20 singletons whose
 *     first act is `relayClient.disconnect()` (`features/communities/useCommunityInit.ts:59-99`).
 *     ⇒ One community per segment means every segment change RECONNECTS THE RELAY and re-keys the
 *       whole app, because `communityKey` also includes `currentPubkey`.
 *
 *   · Upstream Buzz ALREADY HAS server-side multi-tenancy, keyed on the connection host and resolved
 *     before any tenant-scoped path runs, and a client cannot assert it
 *     (`docs/multi-tenant-conformance.md:6,16,23,26-27`; `migrations/0001_initial_schema.sql:40`).
 *     ⇒ The tenant boundary belongs on the SERVER. A segment is a tenant inside one relay, not a
 *       separate relay.
 *
 *   · A channel is already a NIP-29 group (`RawChannelDetail.nip29_group_id`) and its members already
 *     carry `is_agent`, so humans and agents are co-equal in the UI. Segments map onto that, not onto
 *     `Community`.
 *
 * ⇒ SO: ONE community, pointed at the estate's relay. Segments appear as the channels the identity is
 *   entitled to, and a change in entitlement does not require reconnecting anything.
 *
 * Design of record: `dash-app/docs/COMMUNITY_TO_SEGMENT.md`.
 */

/** The estate's relay. ONE community, many tenants. */
export const VCLAW_RELAY_URL = "wss://agents.vclawhub.com";

/**
 * ── THE GROUP PREFIX IS A LIST: CANONICAL FIRST, LEGACY SECOND (operator ruling 2026-10-03) ──────
 * `vclaw.tenant.<name>` is the CANONICAL group prefix. `vchat.tenant.<name>` is a LEGACY ALIAS,
 * accepted only while the estate migrates off it — **`vchat` is SUNSET on 2026-11-02**, so both the
 * legacy prefix below and every branch that reads it are TEMPORARY and go with that date.
 *
 * WHY A LIST AND NOT ONE CONSTANT: with the single legacy constant, an identity whose claim carries
 * the canonical prefix rendered as an identity with NO segment at all — an empty list, which reads
 * as "a name that appears in no live record". The list keeps such a user visible, and
 * `segmentGroupEntry` MARKS the legacy match so the UI shows it AS legacy, never as current.
 *
 * A prefix match is CANONICAL-FIRST: a claim that carries both forms for one name resolves to the
 * canonical one, and the legacy one is reported as the alias it is.
 *
 * Only tenant groups name a SPACE. `vchat.admin` is operator scope, not somewhere to talk, and
 * `greenzone` / `nextcrm` are application admission groups — neither is a room.
 *
 * These are returned to the caller so the UI can REPORT what the identity is entitled to. They are
 * deliberately NOT turned into communities.
 */
export const SEGMENT_GROUP_PREFIXES: readonly string[] = [
  "vclaw.tenant.",
  // LEGACY ALIAS — TEMPORARY. `vchat` is sunset 2026-11-02; remove with it.
  "vchat.tenant.",
];

/** The canonical prefix, named so a reader does not index the list by hand. */
export const SEGMENT_GROUP_CANONICAL_PREFIX = SEGMENT_GROUP_PREFIXES[0];

/** The legacy alias. TEMPORARY: sunset 2026-11-02 (see SEGMENT_GROUP_PREFIXES). */
export const SEGMENT_GROUP_LEGACY_PREFIX = SEGMENT_GROUP_PREFIXES[1];

/** The date the legacy `vchat` estate is sunset. Used verbatim in the user-facing strings. */
export const SEGMENT_LEGACY_SUNSET = "2026-11-02";

/** What a tenant group says, whichever prefix it carried. */
export type SegmentGroupEntry = {
  /** The group EXACTLY as the estate wrote it in the claim, e.g. `vchat.tenant.kuai`. */
  group: string;
  /** The prefix that matched, canonical or legacy. */
  prefix: string;
  /** The bare name, case-folded: what two groups are compared on. */
  name: string;
  /** `Kuai` — the name a person recognises. */
  displayName: string;
  /** True when this group is the LEGACY alias rather than the canonical form. */
  legacy: boolean;
  /** The same name under the canonical prefix — what the estate should migrate to. */
  canonicalGroup: string;
};

/** `kuai` -> `Kuai`, `acme-corp` -> `Acme Corp`. */
function segmentName(raw: string): string {
  return raw
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Read a tenant group through whichever prefix it carries, or `null` when it names no space.
 *
 * The prefix match is case-insensitive (a claim is data, not a constant we control) but the
 * `group` and `canonicalGroup` fields keep their own case, so a caller can show the estate's exact
 * string rather than a normalised one we invented.
 */
export function segmentGroupEntry(group: string): SegmentGroupEntry | null {
  const folded = group.trim().toLowerCase();
  const prefix = SEGMENT_GROUP_PREFIXES.find((candidate) =>
    folded.startsWith(candidate),
  );
  if (!prefix) return null;
  const raw = group.trim().slice(prefix.length).trim();
  if (!raw) return null;
  return {
    group: group.trim(),
    prefix,
    name: raw.toLowerCase(),
    displayName: segmentName(raw),
    legacy: prefix === SEGMENT_GROUP_LEGACY_PREFIX,
    canonicalGroup: `${SEGMENT_GROUP_CANONICAL_PREFIX}${raw}`,
  };
}

/** The tenant groups in a claim — legacy alias included, so a legacy-only user is not an empty list. */
export function segmentGroups(groups: readonly string[]): string[] {
  return [
    ...new Set(groups.filter((g) => segmentGroupEntry(g) !== null)),
  ].sort();
}

/** `vchat.tenant.kuai` -> `Kuai`. The segment name is what a person recognises. */
export function segmentDisplayName(group: string): string {
  const entry = segmentGroupEntry(group);
  // No known prefix: hand back the caller's own string rather than slice a prefix that is not
  // there, which is what the single-constant version did to every canonical group.
  return entry ? entry.displayName : group;
}

export type ProvisionResult = {
  /** Tenant groups present in the claim. NOT communities — the spaces the identity may enter. */
  segments: string[];
  /** True when the community was created by this call. */
  added: boolean;
  /** True when it was already present and left untouched. */
  existing: boolean;
  /** The active community id after the call, if any. */
  activeId: string | null;
  /** Set when persistence refused; the caller must NOT assert success. */
  error?: string;
};

/**
 * Ensure the ONE estate community exists and is selected.
 *
 * ADDITIVE BY CONSTRUCTION: existing communities are read and preserved, and a re-login never
 * removes one. A no-op write is skipped deliberately — a write that changes nothing is only a chance
 * to lose data.
 *
 * `pubkey` is deliberately absent. `Community.pubkey` is documented as display-only ("auth always
 * uses the persisted `identity.key` file resolved at startup, never this field"), and at login time
 * the device key does not exist yet — design B keeps the key and the subject SEPARATE, so the app
 * creates the key after the login. Writing a placeholder here would be a claim we cannot support.
 */
export function provisionVclawCommunity(
  groups: readonly string[],
  relayUrl: string = VCLAW_RELAY_URL,
): ProvisionResult {
  const segments = segmentGroups(groups);
  const base: ProvisionResult = {
    segments,
    added: false,
    existing: false,
    activeId: null,
  };

  let communities: Community[];
  try {
    communities = loadCommunities();
  } catch {
    return { ...base, error: "could not read existing communities" };
  }

  const normalized = normalizeRelayUrl(relayUrl);
  const match = communities.find(
    (c) => normalizeRelayUrl(c.relayUrl) === normalized,
  );

  if (match) {
    // Already present. Select it only if nothing is selected, so a re-login never yanks the operator
    // out of wherever they were. NOTE: we do NOT rename it — its name is the operator's.
    const active = communities.find((c) => c.relayUrl && c.id === match.id);
    if (!active)
      return { ...base, error: "community present but unresolvable" };
    return { ...base, existing: true, activeId: active.id };
  }

  const community: Community = {
    id: crypto.randomUUID(),
    name: "vclaw",
    relayUrl: normalized,
    addedAt: new Date().toISOString(),
  };
  const next = [...communities, community];
  if (!saveCommunities(next)) {
    return { ...base, error: "could not persist the community" };
  }
  saveActiveCommunityId(community.id);
  return { ...base, added: true, activeId: community.id };
}
