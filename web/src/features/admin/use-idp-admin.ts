/**
 * TanStack Query hooks over the read seam — one hook per phase-1 endpoint.
 *
 * Two deliberate policy choices, both about honesty rather than performance:
 *
 *  - `retry: false` on every read (the app's global default is one retry). A
 *    fail-closed refusal is a decision, not a blip: asking the gateway again
 *    will not turn a 401 into a 200, and retrying only delays telling the
 *    operator what happened.
 *  - the source is part of the query key. A staged capture and a live read are
 *    different answers to the same question, so they must never share a cache
 *    entry.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import * as React from "react";

import {
  IDP_PATHS,
  idpAuthEventsPath,
  idpConsentPath,
  idpConsentSummaryPath,
} from "./idp-paths";
import { type IdpSource, liveIdpSource, stagedIdpSource } from "./idp-source";
import type {
  IdpAuthEventsResponse,
  IdpClientResponse,
  IdpClientsResponse,
  IdpConsentResponse,
  IdpConsentSummaryResponse,
  IdpHealthResponse,
  IdpSessionsResponse,
} from "./idp-types";

const FIXTURE_PARAM = "fixture";

export type ConsoleSearch = {
  /** The requested tab, or null for the default. */
  tab: string | null;
  /** The staged fixture id, or null for a live source. */
  fixture: string | null;
};

/** Parse `?fixture=…&tab=…` without a router: this page is reachable by URL only. */
export function parseConsoleSearch(search: string): ConsoleSearch {
  const params = new URLSearchParams(search);
  const fixture = params.get(FIXTURE_PARAM);
  return {
    tab: params.get("tab"),
    fixture: fixture && fixture.length > 0 ? fixture : null,
  };
}

export type ConsoleSourceState = {
  source: IdpSource | null;
  /** Set when `?fixture=` names a capture that does not exist. Fail closed. */
  fixtureError: string | null;
  search: ConsoleSearch;
};

/**
 * The source this page reads from. A missing `?fixture=` means live. An UNKNOWN
 * `?fixture=` value is refused rather than ignored: silently reading live data
 * while the URL asks for a staged capture would be the worst of both.
 */
export function useConsoleSource(fallbackSearch?: string): ConsoleSourceState {
  const search = React.useMemo(
    () => parseConsoleSearch(fallbackSearch ?? window.location.search),
    [fallbackSearch],
  );
  return React.useMemo(() => {
    if (!search.fixture) {
      return { source: liveIdpSource(), fixtureError: null, search };
    }
    try {
      return {
        source: stagedIdpSource(search.fixture),
        fixtureError: null,
        search,
      };
    } catch (cause) {
      return {
        source: null,
        fixtureError: cause instanceof Error ? cause.message : String(cause),
        search,
      };
    }
  }, [search]);
}

export function useIdpRead<T>(
  source: IdpSource | null,
  path: string,
): UseQueryResult<T, unknown> {
  return useQuery<T, unknown>({
    queryKey: [
      "idp-admin",
      source?.kind ?? "none",
      source?.fixture?.id ?? "gateway",
      path,
    ],
    queryFn: () => {
      if (!source) throw new Error("no read source");
      return source.read<T>(path);
    },
    enabled: source !== null,
    retry: false,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useIdpClients(source: IdpSource | null) {
  return useIdpRead<IdpClientsResponse>(source, IDP_PATHS.clients);
}

export function useIdpClient(source: IdpSource | null, clientId: string) {
  return useIdpRead<IdpClientResponse>(source, IDP_PATHS.client(clientId));
}

export function useIdpConsent(source: IdpSource | null, state?: string) {
  return useIdpRead<IdpConsentResponse>(source, idpConsentPath(state));
}

export function useIdpConsentSummary(source: IdpSource | null) {
  return useIdpRead<IdpConsentSummaryResponse>(source, idpConsentSummaryPath());
}

export function useIdpAuthEvents(source: IdpSource | null, outcome?: string) {
  return useIdpRead<IdpAuthEventsResponse>(source, idpAuthEventsPath(outcome));
}

export function useIdpSessions(source: IdpSource | null) {
  return useIdpRead<IdpSessionsResponse>(source, IDP_PATHS.sessionsSummary);
}

export function useIdpHealth(source: IdpSource | null) {
  return useIdpRead<IdpHealthResponse>(source, IDP_PATHS.health);
}
