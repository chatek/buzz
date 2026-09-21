/**
 * THE READ SEAM between the console and `/api/idp/*`.
 *
 * Two implementations, ONE interface:
 *
 *  - `liveIdpSource()` talks to the gateway, using the app's own credential
 *    helper (`shared/lib/relay-auth.ts`, NIP-98 today) and the same relative
 *    API base the invite flow uses. It adds no new fetch layer.
 *  - `stagedIdpSource(id)` answers from a recorded fixture in `idp-fixtures.ts`.
 *    This is what keeps the classification verifiable independently of the live
 *    surface: MEASURED 2026-09-22, every `/api/idp/*` read is refused at admission
 *    with `401 restricted: missing Authorization`, so a staged capture is the only
 *    way to exercise the views without waiting for admission. Nothing about a read
 *    is inferred from that refusal — the console reports it and stops there.
 *
 * THE FAIL-CLOSED RULE, which is the reason this file is larger than a fetch
 * wrapper: a refusal is NEVER an empty list, a zero, or a spinner. Every
 * failure is classified into a named state, and each state carries the sentence
 * an operator needs plus the server's own words as evidence. The `restricted:`
 * vocabulary of the gateway is preserved verbatim, so a reader (or a future
 * classifier) sees exactly what the service said.
 */

import { buildRelayAuthHeaders } from "@/shared/lib/relay-auth";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import { type StagedFixture, stagedFixture } from "./idp-fixtures";
import { type IdpQueryParams, withQuery } from "./idp-paths";
import type { IdpErrorBody } from "./idp-types";

export { IDP_PATHS } from "./idp-paths";

/**
 * The read has a deadline. A hung request must not leave the console on a
 * spinner: after this many milliseconds the read FAILS, and the failure is
 * rendered as "no answer within N seconds" rather than as an endless wait.
 */
export const IDP_READ_TIMEOUT_MS = 15_000;

/** After this long, an unsettled read also says out loud that it is still waiting. */
export const IDP_SLOW_READ_MS = 8_000;

export type IdpFailureKind =
  /** 401: the gateway refused the caller before the read model was reached. */
  | "not_authorized"
  /** 403 with the `restricted:` vocabulary: authority, not authentication. */
  | "restricted"
  /** 404 naming a client that is not in the projection (a real state). */
  | "not_found"
  /** 501 / 404-unknown-endpoint / HTML in place of JSON: nothing is mounted here. */
  | "not_mounted"
  /** 503: the endpoint exists and refuses to answer (guard, wiring, or degraded health). */
  | "unavailable"
  /** 400: this console sent something the endpoint rejected. */
  | "bad_request"
  /** The browser could not produce a credential to sign the read. */
  | "no_credential"
  /** The request never completed (offline, DNS, TLS, or the deadline above). */
  | "unreachable"
  /** The URL named a staged capture that does not exist: the console's own input. */
  | "bad_fixture"
  /** Anything else. */
  | "unexpected";

export type IdpFailure = {
  kind: IdpFailureKind;
  status: number | null;
  path: string;
  title: string;
  meaning: string;
  /** The service's own words, or the transport's. Quoted, never paraphrased. */
  evidence: string;
};

/**
 * THE ONE TABLE BOTH SURFACES READ FROM — and the reason it is ONE table.
 *
 * LANE 2 found this state machine implemented twice and extended once:
 * `IdpFailureKind` declares `restricted` (403) and the classifier produces it, the
 * NOTICE mapping knew it ("Restricted"), and the HEADER mapping (`observedSurface`)
 * did not — so a 403 rendered "Restricted" in the notice and "does not match any
 * state the console knows" in the header. The same event, two surfaces,
 * contradictory. And it is a POST-ADMISSION state, so it appears the moment
 * admission lands.
 *
 * Adding 403 to the second switch would have fixed the symptom and kept the cause.
 * Instead, every kind has exactly one entry here, typed as
 * `Record<IdpFailureKind, …>`, and BOTH surfaces read it:
 *
 *   - the notice takes `title`, `meaning`, `nextStep` and `icon`;
 *   - the header takes `outcome` and `headerSentence`.
 *
 * CONSEQUENCE, which is the point: adding a member to `IdpFailureKind` without
 * teaching BOTH surfaces is a TYPE ERROR — the compiler refuses a state that only
 * one surface understands. "Remember to update both places" is not a mechanism;
 * a missing key is.
 *
 * `outcome` is a BUCKET, NOT A DISCRIMINANT. MEASURED: 401 and not-mounted both
 * render `refused`, so two different states share one bucket on purpose. Never key
 * a check on the outcome alone — the title and the quoted response shape are what
 * separate the states, and that is what the tests assert.
 */
export const FAILURE_SURFACE: Record<
  IdpFailureKind,
  {
    /** Short headline, shown first on both surfaces. */
    title: string;
    /** What this state means, in the notice. */
    meaning: string;
    /** What an operator should do next, in the notice. */
    nextStep: string;
    /** Which icon the notice draws. */
    icon: "key" | "plug" | "warning";
    /** The bucket the header reports. NOT a discriminant: see above. */
    outcome: SurfaceOutcome;
    /** The header's sentence about THIS page's own probe. */
    headerSentence: string;
  }
> = {
  not_authorized: {
    title: "Not authorized yet",
    meaning:
      "The gateway refused this read at admission, before the read model was reached. The IdP admin surface answers only a caller it can resolve to a principal. This notice reports the refusal THIS read received, and nothing more: it is not a statement about whether the surface would answer a different caller.",
    nextStep:
      "Nothing was returned and nothing was withheld: the caller was refused at the door. This notice describes the refusal this read received; it makes no claim about whether the endpoint exists beyond that.",
    icon: "key",
    outcome: "refused",
    headerSentence:
      "This page probed the surface and was refused at admission (HTTP 401); no read reached the read model.",
  },
  restricted: {
    title: "Restricted",
    meaning:
      "The caller was recognized, and the authority check declined. Read scope is the set of client ids owned by the caller's organizations, resolved from the directory on every request.",
    nextStep:
      "Nothing was returned. Ask the operator to add the client to an organization you belong to, or to give you the admin group for it.",
    icon: "key",
    outcome: "refused",
    headerSentence:
      "This page probed the surface, its caller was recognized, and the authority check declined the read (HTTP 403).",
  },
  not_found: {
    title: "No such client in the inventory",
    meaning:
      "The caller is allowed to read this client id, and the client is not in the projection. That is a real state: a client removed from the live configuration can still hold rows in the grant log.",
    nextStep:
      "Nothing was returned. The grant log can still hold rows for this client; open the consent view and look for its client id.",
    icon: "warning",
    outcome: "refused",
    headerSentence:
      "This page probed the surface and the client it asked about is not in the inventory (HTTP 404).",
  },
  not_mounted: {
    title: "This surface is not mounted",
    meaning:
      "Nothing is serving the IdP admin endpoints at this path. Either the gateway is running without the mount, or a static host answered the API path with the single-page-app fallback. No data was returned, and no data was withheld.",
    nextStep:
      'The endpoint exists in the read model but is not serving here. A 501 is the gateway\'s own "not implemented" answer; a web page in place of JSON means a static host answered the API path. Either way, "surface not mounted" is not "no data".',
    icon: "plug",
    outcome: "refused",
    headerSentence:
      "This page probed the surface and nothing was mounted at the path it asked for.",
  },
  unavailable: {
    title: "The read model is not answering",
    meaning:
      "The endpoint exists and refused to answer. The body names the reason: a schema guard refusal, a missing configuration file, or a degraded health block. A refusal is not an empty result.",
    nextStep:
      "The endpoint answered and refused — a 503, not an empty result. The detail above is the service's reason, and the health view shows the same state without the refusal.",
    icon: "plug",
    outcome: "refused",
    headerSentence:
      "This page probed the surface and the read model refused to answer (HTTP 503).",
  },
  bad_request: {
    title: "The endpoint rejected this request",
    meaning:
      "A parameter this console sent was not accepted. The filter is echoed back in the payload when the call succeeds; a rejected filter is never silently widened.",
    nextStep:
      "Nothing was returned. This console builds its own filters, so a rejected one is a defect worth reporting with the path shown above.",
    icon: "warning",
    outcome: "refused",
    headerSentence:
      "This page probed the surface and the request it sent was rejected (HTTP 400).",
  },
  no_credential: {
    title: "No credential could be produced",
    meaning:
      "Signing the read failed in the browser, so nothing was sent. No data was returned and no identity was asserted.",
    nextStep:
      "Nothing was sent. The console signs its reads with the app's existing credential helper; a failure there is shown rather than worked around.",
    icon: "key",
    outcome: "unreachable",
    headerSentence:
      "This page could not produce a credential to sign its probe, so the surface was never reached.",
  },
  unreachable: {
    title: "The gateway did not answer",
    meaning:
      "The request did not complete: the host is unreachable, or it did not answer within the deadline. This is a transport fact, not an empty result.",
    nextStep:
      "Nothing was returned. Check that the gateway is up and reachable from this browser, then try again.",
    icon: "plug",
    outcome: "unreachable",
    headerSentence:
      "This page's probe of the surface did not complete, so nothing here says whether it would have answered.",
  },
  bad_fixture: {
    title: "Unknown staged capture",
    meaning:
      "The capture named on this URL does not exist, so no source could be built. The console refuses rather than quietly reading live data under a URL that asked for staged data.",
    nextStep:
      "Nothing was read. Open the page again with one of the capture ids listed below, or with no fixture parameter at all to read the live surface.",
    icon: "warning",
    outcome: "uninterpreted",
    headerSentence:
      "The URL named a staged capture that does not exist, so this page built no read source and contacted nothing.",
  },
  unexpected: {
    title: "Unexpected reply",
    meaning:
      "The reply did not match any state this console knows. It is shown verbatim rather than interpreted.",
    nextStep:
      "Nothing was interpreted. The raw reply is quoted above so it can be read as what it is.",
    icon: "warning",
    outcome: "uninterpreted",
    headerSentence:
      "This page's probe returned a reply that matches no state the console knows; it is quoted below rather than interpreted.",
  },
};

/** Every kind, at runtime, for the table-driven tests over the union. */
export const ALL_FAILURE_KINDS = Object.keys(
  FAILURE_SURFACE,
) as IdpFailureKind[];

export class IdpReadError extends Error {
  readonly kind: IdpFailureKind;
  readonly status: number | null;
  readonly path: string;
  readonly evidence: string;

  constructor(init: {
    kind: IdpFailureKind;
    path: string;
    status?: number | null;
    evidence: string;
  }) {
    super(`${init.kind} ${init.path}: ${init.evidence}`);
    this.name = "IdpReadError";
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.path = init.path;
    this.evidence = init.evidence;
  }
}

/** The display form of any thrown read failure. Never returns a bare "Error". */
export function toIdpFailure(err: unknown): IdpFailure {
  if (err instanceof IdpReadError) {
    const copy = FAILURE_SURFACE[err.kind];
    return {
      kind: err.kind,
      status: err.status,
      path: err.path,
      title: copy.title,
      meaning: copy.meaning,
      evidence: err.evidence,
    };
  }
  return {
    kind: "unexpected",
    status: null,
    path: "",
    title: FAILURE_SURFACE.unexpected.title,
    meaning: FAILURE_SURFACE.unexpected.meaning,
    evidence: err instanceof Error ? err.message : String(err),
  };
}

export type IdpSource = {
  /** `live` reads the gateway; `staged` reads a recorded fixture. */
  readonly kind: "live" | "staged";
  /** One sentence naming where the numbers come from. Shown in the header. */
  readonly description: string;
  /** Present only for a staged source: this console refuses to hide it. */
  readonly fixture?: StagedFixture;
  read<T>(path: string, query?: IdpQueryParams): Promise<T>;
};

// ---------------------------------------------------------------------------
// THE SURFACE OBSERVATION — what THIS PAGE observed, never what the system is
//
// WHY IT EXISTS. The console's header used to carry a build-time sentence: "the
// endpoints are not mounted yet". A reviewer with a real browser against the LIVE
// `/admin` saw that sentence next to panels that were answering 401 — a claim about
// the API's state, written when the file was written, still on screen after the
// state had moved. The panels were right; the sentence was stale.
//
// So the header makes NO claim of its own. It renders the result of the page's OWN
// probe of the surface, with the time it was taken, and the vocabulary of that
// sentence is manufactured from the OBSERVED outcome alone: answered, refused,
// unreachable, not yet read, or staged (no gateway contacted).
// ---------------------------------------------------------------------------

export type SurfaceOutcome =
  | "reading"
  | "answered"
  | "refused"
  | "unreachable"
  | "uninterpreted"
  | "staged";

export type ObservedSurface = {
  outcome: SurfaceOutcome;
  /** ISO timestamp of the observation, or null when nothing has been observed yet. */
  readAt: string | null;
  /** One sentence about this page's own read. It describes no other state. */
  sentence: string;
};

/**
 * Derive the header's line from the probe's result. Every branch says what THIS
 * PAGE did or received; none of them says what the service "is", where it is
 * deployed, or what it should answer next.
 */
export function observedSurface(input: {
  kind: "live" | "staged";
  isPending: boolean;
  isError: boolean;
  error?: unknown;
  hasData: boolean;
  at: string | null;
}): ObservedSurface {
  if (input.kind === "staged") {
    return {
      outcome: "staged",
      readAt: input.at,
      sentence:
        "No gateway was contacted for this page: every read below was answered from the staged capture named above.",
    };
  }
  if (input.isPending) {
    return {
      outcome: "reading",
      readAt: null,
      sentence:
        "This page is reading the surface now; the result of its own probe is not in yet.",
    };
  }
  if (input.isError) {
    // ONE lookup, not a chain of `if`s. A kind that is not in the table cannot be
    // constructed (the table is a `Record<IdpFailureKind, …>`), so this branch has
    // no fallback to fall into — which is exactly what the 403 defect was.
    const failure = toIdpFailure(input.error);
    const copy = FAILURE_SURFACE[failure.kind];
    return {
      outcome: copy.outcome,
      readAt: input.at,
      sentence: copy.headerSentence,
    };
  }
  if (input.hasData) {
    return {
      outcome: "answered",
      readAt: input.at,
      sentence:
        "This page probed the surface and the read model answered it. Every number below is a reading taken at the time shown.",
    };
  }
  return {
    outcome: "reading",
    readAt: null,
    sentence:
      "This page has not yet observed an outcome from the surface, so it makes no claim about it.",
  };
}

/**
 * WHEN THE PAGE LAST LOOKED — stamped from the SETTLED READ, not from success.
 *
 * LANE 2 found this defect: `readAt` came only from `dataUpdatedAt`, which is
 * `null` on error, so on a FAILED read the observation could not say when it was
 * taken — while a staged capture was dated. That is backwards: the failed read is
 * exactly the one where "when did we look?" matters most, because it is the
 * dimension that separates an observation from a stale sentence.
 *
 * React Query stamps both outcomes: `dataUpdatedAt` on success and
 * `errorUpdatedAt` on failure. Taking the later of the two means the stamp follows
 * whichever the read actually produced, and a REFUSED read carries a real time
 * that MOVES between runs. A test asserts that movement, because a constant stamp
 * passes a presence check and proves nothing.
 */
export function observationStamp(input: {
  isPending: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  /** The page's own clock, read when it first saw the read settle. */
  observedAt?: number | null;
}): { at: string | null; source: "query" | "page-clock" | null } {
  if (input.isPending) return { at: null, source: null };
  const fromQuery = Math.max(input.dataUpdatedAt, input.errorUpdatedAt);
  if (Number.isFinite(fromQuery) && fromQuery > 0) {
    return { at: new Date(fromQuery).toISOString(), source: "query" };
  }
  // MEASURED: React Query can report BOTH timestamps as 0 for a failed read, so
  // "the query told us when" is not always available — and a refused read is the
  // one where the time matters most. The page's own clock, read at the moment it
  // saw the read settle, is the sanctioned fallback; `source` is returned so the
  // UI can say WHERE the time came from rather than presenting the two as the same
  // kind of fact.
  const observed = input.observedAt;
  if (
    typeof observed === "number" &&
    Number.isFinite(observed) &&
    observed > 0
  ) {
    return { at: new Date(observed).toISOString(), source: "page-clock" };
  }
  return { at: null, source: null };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

function parseJson(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Map an HTTP status onto a displayed state. The subtle cases:
 *
 *  - 501 is the gateway's own answer for "this lane is not implemented"
 *    (`internal/nip01/server.go` apiFallback) — that is "not mounted", not
 *    "server error".
 *  - a 200 that is NOT JSON is also "not mounted": a static host answered the
 *    API path with the app shell. A dev or preview server does exactly this.
 *  - 404 is "no such client" only when the body says so; otherwise it is an
 *    unmounted path.
 */
export function classifyHttpFailure(
  status: number,
  contentType: string | null,
  body: IdpErrorBody | null,
  rawText: string,
  path: string,
): IdpReadError {
  const server = body?.error?.trim() ?? "";
  const detail = body?.detail?.trim() ?? "";
  const evidenceParts = [`HTTP ${status}`];
  if (contentType) evidenceParts.push(`content-type ${contentType}`);
  if (server) evidenceParts.push(`"${server}"`);
  if (detail) evidenceParts.push(`detail "${detail}"`);
  if (!server && rawText.trim()) {
    evidenceParts.push(`body starts "${rawText.trim().slice(0, 120)}"`);
  }
  const evidence = evidenceParts.join(" · ");
  const match = (needle: string) => server.toLowerCase().includes(needle);

  if (status === 401) {
    return new IdpReadError({ kind: "not_authorized", path, status, evidence });
  }
  if (status === 403) {
    return new IdpReadError({ kind: "restricted", path, status, evidence });
  }
  if (status === 400) {
    return new IdpReadError({ kind: "bad_request", path, status, evidence });
  }
  if (status === 501) {
    return new IdpReadError({ kind: "not_mounted", path, status, evidence });
  }
  if (status === 404) {
    const kind: IdpFailureKind = match("is not in the client projection")
      ? "not_found"
      : "not_mounted";
    return new IdpReadError({ kind, path, status, evidence });
  }
  if (status === 503) {
    return new IdpReadError({ kind: "unavailable", path, status, evidence });
  }
  return new IdpReadError({ kind: "unexpected", path, status, evidence });
}

export function liveIdpSource(): IdpSource {
  const base = relayHttpBaseUrl().replace(/\/+$/, "");
  return {
    kind: "live",
    description: `Live gateway: ${base} (the same origin the invite flow uses; credential seam is shared/lib/relay-auth.ts).`,
    async read<T>(path: string, query?: IdpQueryParams): Promise<T> {
      const url = `${base}${withQuery(path, query)}`;
      let headers: Record<string, string>;
      try {
        headers = await buildRelayAuthHeaders({ url, method: "GET" });
      } catch (cause) {
        throw new IdpReadError({
          kind: "no_credential",
          path,
          evidence: cause instanceof Error ? cause.message : String(cause),
        });
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers,
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(IDP_READ_TIMEOUT_MS),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new IdpReadError({
          kind: "unreachable",
          path,
          evidence: `${message} (deadline ${IDP_READ_TIMEOUT_MS} ms)`,
        });
      }
      const text = await response.text();
      const parsed = parseJson(text);
      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        throw classifyHttpFailure(
          response.status,
          contentType,
          parsed.ok ? (parsed.value as IdpErrorBody) : null,
          text,
          path,
        );
      }
      if (!parsed.ok) {
        throw new IdpReadError({
          kind: "not_mounted",
          path,
          status: response.status,
          evidence: `HTTP ${response.status} with content-type ${contentType ?? "unset"}: the body is not JSON, so this path answered with a document, not the read model.`,
        });
      }
      return parsed.value as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Staged
// ---------------------------------------------------------------------------

/**
 * A staged source over the recorded fixtures. Its `description` and its
 * `fixture.captureNote` are rendered as a banner on every panel: a screenshot of
 * this mode can never be mistaken for the live IdP.
 */
export function stagedIdpSource(id: string): IdpSource {
  const fixture = stagedFixture(id);
  return {
    kind: "staged",
    description: `STAGED DATA — fixture "${fixture.id}" (${fixture.captureNote}). No gateway was contacted.`,
    fixture,
    async read<T>(path: string, query?: IdpQueryParams): Promise<T> {
      // The query string affects which payload answers, exactly as a live
      // filter would, so a screenshot of a filtered view is still labelled.
      const key = withQuery(path, query);
      const payload = fixture.payloads[key] ?? fixture.payloads[path];
      if (payload === undefined) {
        throw new IdpReadError({
          kind: "unexpected",
          path,
          evidence: `the staged fixture "${fixture.id}" holds no payload for ${key}. Staged data must not answer a question it has no capture for.`,
        });
      }
      return payload as T;
    },
  };
}
