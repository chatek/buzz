/**
 * RULING C(i) — the server-advertised channel capability set, client half
 * (CHANNELS_SERVICE_ACL.md §5, commit feaa8054).
 *
 * The relay advertises its enabled channel features in the NIP-11 document's
 * `channels` field (both /info and the WS root — internal/nip01/server.go).
 * This module fetches that field ONCE per community connect for the ACTIVE
 * community (the same NIP-11 probe `fetch_workspace_icon` established: plain
 * unauthenticated HTTP through the Tauri backend) and publishes the DERIVED
 * affordance set to every render site.
 *
 * THE CONTRACT, stated once:
 *   - the compile-time table (CHANNELS_ALPHA_AFFORDANCES) is the FALLBACK;
 *     with the field absent, malformed, or the relay unreachable, the derived
 *     set IS that object, so today's behaviour is byte-identical;
 *   - per-key: a key the server states (as a boolean) wins; every other key
 *     keeps its compile-time verdict (`parseChannelsCapabilities` /
 *     `deriveChannelsAlphaAffordances` in channelsAlphaAffordances.ts);
 *   - a community switch resets to the fallback FIRST, so one relay's caps can
 *     never bleed into the next community's render.
 *
 * WHY A MODULE STORE AND NOT CONTEXT: the render sites (sidebar sections,
 * sort picker, templates, canvases, the DM affordances) include leaf components
 * that tests mount without the CommunitiesProvider. `useSyncExternalStore`
 * reads the set with zero provider requirements and re-renders every subscriber
 * when a new relay answer lands. Only `useRelayChannelCapsSync` needs React
 * Query, and it is mounted exactly once, at the AppShell.
 */
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { invokeTauri } from "@/shared/api/tauri";
import {
  CHANNELS_ALPHA_AFFORDANCES,
  type ChannelAlphaAffordanceSet,
  deriveChannelsAlphaAffordances,
  parseChannelsCapabilities,
} from "./channelsAlphaAffordances";

export const relayChannelCapsQueryKey = (relayUrl: string) =>
  ["relayChannelCaps", relayUrl] as const;

/** Stale for 5 minutes — the icon probe's own window (useCommunityIcons.ts). */
const CAPS_STALE_MS = 5 * 60_000;

/**
 * Fetch the relay's `channels` capability field (raw JSON) via the same
 * NIP-11 GET the icon uses. Errors propagate to the query (retry: 1); the
 * store keeps the fallback either way — an unreachable relay is not a verdict.
 */
export async function fetchRelayChannelCaps(
  relayUrl: string,
): Promise<unknown> {
  return invokeTauri<unknown>("fetch_workspace_channel_caps", { relayUrl });
}

// ─── the derived-set store (one writer: applyServerChannelCaps) ─────────────

let currentSet: ChannelAlphaAffordanceSet = CHANNELS_ALPHA_AFFORDANCES;
const listeners = new Set<() => void>();

function setDerived(next: ChannelAlphaAffordanceSet) {
  let changed = false;
  for (const key of Object.keys(CHANNELS_ALPHA_AFFORDANCES) as Array<
    keyof ChannelAlphaAffordanceSet
  >) {
    if (currentSet[key] !== next[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    return;
  }
  currentSet = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Apply a raw NIP-11 `channels` value (unknown by design — the parser is the
 * only validator). Absent/malformed input derives the fallback verbatim.
 * Test seam: exported for the unit tests; production callers are the sync hook
 * and nothing else.
 */
export function applyServerChannelCaps(raw: unknown): void {
  setDerived(deriveChannelsAlphaAffordances(parseChannelsCapabilities(raw)));
}

/** Reset to the compile-time table — the community-switch and teardown verb. */
export function resetServerChannelCaps(): void {
  setDerived(CHANNELS_ALPHA_AFFORDANCES);
}

/** The current derived set (snapshot; stable identity until it changes). */
export function getChannelsAlphaAffordances(): ChannelAlphaAffordanceSet {
  return currentSet;
}

function subscribeChannelCaps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The derived affordance set for THIS community. Reads the store — no fetch,
 * no provider, no crash in provider-less test mounts; the value starts at the
 * compile-time table and updates when the active relay's answer lands.
 */
export function useChannelsAlphaAffordances(): ChannelAlphaAffordanceSet {
  return React.useSyncExternalStore(
    subscribeChannelCaps,
    getChannelsAlphaAffordances,
    getChannelsAlphaAffordances,
  );
}

/**
 * The ONE community-connect fetch. Mount once (the AppShell does) with the
 * ACTIVE community's relay URL. Undefined/empty = no active community: reset
 * to the fallback and fetch nothing.
 */
export function useRelayChannelCapsSync(relayUrl: string | undefined): void {
  // One normalized key: "" is the no-community state, and A→B relay switches
  // (both non-empty) are what the effect below must react to.
  const relayUrlKey = typeof relayUrl === "string" ? relayUrl : "";
  const enabled = relayUrlKey !== "";
  const capsQuery = useQuery({
    queryKey: relayChannelCapsQueryKey(relayUrlKey),
    queryFn: () => fetchRelayChannelCaps(relayUrlKey),
    enabled,
    staleTime: CAPS_STALE_MS,
    retry: 1,
  });
  const capsData = capsQuery.data;
  // capsData IS the relay-change signal: the query is keyed by relayUrlKey,
  // and a key change swaps the cache entry, so data goes undefined (reset,
  // below) until the new relay answers — the reset-then-apply order is what
  // keeps one community's caps out of the next one's render.
  React.useEffect(() => {
    if (!enabled) {
      resetServerChannelCaps();
      return;
    }
    resetServerChannelCaps();
    if (capsData !== undefined) {
      applyServerChannelCaps(capsData);
    }
  }, [enabled, capsData]);
}
