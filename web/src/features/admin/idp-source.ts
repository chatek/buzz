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

const FAILURE_COPY: Record<IdpFailureKind, { title: string; meaning: string }> =
  {
    not_authorized: {
      title: "Not authorized yet",
      meaning:
        "The gateway refused this read at admission, before the read model was reached. The IdP admin surface answers only a caller it can resolve to a principal. This notice reports the refusal THIS read received, and nothing more: it is not a statement about whether the surface would answer a different caller.",
    },
    restricted: {
      title: "Restricted",
      meaning:
        "The caller was recognized, and the authority check declined. Read scope is the set of client ids owned by the caller's organizations, resolved from the directory on every request.",
    },
    not_found: {
      title: "No such client in the inventory",
      meaning:
        "The caller is allowed to read this client id, and the client is not in the projection. That is a real state: a client removed from the live configuration can still hold rows in the grant log.",
    },
    not_mounted: {
      title: "This surface is not mounted",
      meaning:
        "Nothing is serving the IdP admin endpoints here. Either the gateway is running without the mount patch, or a static host answered the API path with the single-page-app fallback. No data was returned, and no data was withheld.",
    },
    unavailable: {
      title: "The read model is not answering",
      meaning:
        "The endpoint exists and refused to answer. The body names the reason: a schema guard refusal, a missing configuration file, or a degraded health block. A refusal is not an empty result.",
    },
    bad_request: {
      title: "The endpoint rejected this request",
      meaning:
        "A parameter this console sent was not accepted. The filter is echoed back in the payload when the call succeeds; a rejected filter is never silently widened.",
    },
    no_credential: {
      title: "No credential could be produced",
      meaning:
        "Signing the read failed in the browser, so nothing was sent. No data was returned and no identity was asserted.",
    },
    unreachable: {
      title: "The gateway did not answer",
      meaning:
        "The request did not complete: the host is unreachable, or it did not answer within the deadline. This is a transport fact, not an empty result.",
    },
    unexpected: {
      title: "Unexpected reply",
      meaning:
        "The reply did not match any state this console knows. It is shown verbatim rather than interpreted.",
    },
  };

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
    const copy = FAILURE_COPY[err.kind];
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
    title: FAILURE_COPY.unexpected.title,
    meaning: FAILURE_COPY.unexpected.meaning,
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
    const failure = toIdpFailure(input.error);
    if (failure.kind === "not_authorized") {
      return {
        outcome: "refused",
        readAt: input.at,
        sentence:
          "This page probed the surface and was refused before any data was read (HTTP 401). The panels below report each refused read separately.",
      };
    }
    if (failure.kind === "not_mounted") {
      return {
        outcome: "refused",
        readAt: input.at,
        sentence:
          "This page probed the surface and nothing was mounted at the path it asked for. The panels below report each read separately.",
      };
    }
    if (failure.kind === "unavailable") {
      return {
        outcome: "refused",
        readAt: input.at,
        sentence:
          "This page probed the surface and the read model refused to answer it (HTTP 503). The panels below report each refused read separately.",
      };
    }
    if (failure.kind === "unreachable") {
      return {
        outcome: "unreachable",
        readAt: input.at,
        sentence:
          "This page's probe of the surface did not complete, so nothing here says whether it would have answered.",
      };
    }
    return {
      outcome: "refused",
      readAt: input.at,
      sentence: `This page's probe of the surface did not match any state the console knows: ${failure.evidence}`,
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
