/**
 * THE READINESS STATE MACHINE — what this console is allowed to claim about the
 * phase-2 surface, and therefore which controls it may render.
 *
 * READ FROM THE CONTRACT, NOT INVENTED: the four rows of
 * `.prime/handoff/idp-build/j19/PHASE2_DESIGN.md` §8. The probe is a single read
 * of `GET /api/idp/changes` and the classification is:
 *
 *   501                                   -> "absent"          (not mounted)
 *   401  with `restricted:` in the body   -> "mounted_closed"  (mounted, refuses everyone)
 *   200  with `schema: idp.changes.v1`    -> "ready"
 *   anything else, or no reply at all     -> "unknown"
 *
 * The distinction the whole file exists for: **501 is not 401.** A 501 is the
 * gateway's own "/api/ fallback" answering for a route that does not exist
 * (`READ internal/nip01/server.go` apiFallback); a button that calls a
 * non-existent route is worse than no button, so `absent` renders no controls and
 * no panels. A 401 means the route EXISTS and refuses every caller, because
 * layer 1b (`npub -> principal`) is still a stub — a state an operator must be
 * able to see, because "not deployed" and "deployed and unusable yet" are
 * different facts about the deployment.
 *
 * Both this function and `../idp-source.ts` classify an HTTP reply, and they are
 * NOT the same classifier: phase 1's answers "what happened to this read", this
 * one answers "which state is the surface in". This one is deliberately narrower,
 * because a wrong `ready` enables a write control — a wrong `unknown` only hides
 * one. That asymmetry is why every branch that is not one of the three exact
 * shapes above returns `unknown`.
 *
 * PURE: no fetch, no React, no clock. Given a probe it returns a string, which is
 * what makes the controls' gating testable without a browser.
 */

import { PHASE2_SCHEMA } from "./phase2-types";

export type Phase2Readiness = "absent" | "mounted_closed" | "ready" | "unknown";

/**
 * What the probe observed. `status: null` means NO REPLY ARRIVED (offline, DNS,
 * TLS, deadline) — which is not a status code and must never be rendered as one.
 */
export type Phase2Probe = {
  /** The HTTP status, or `null` when the request never produced one. */
  status: number | null;
  /** The raw reply body, exactly as it arrived, or `null` when there was none. */
  body: string | null;
  /** The transport failure, when there was one. Quoted, never paraphrased. */
  transportError?: string | null;
  /** The path that was probed, so the operator sentence can name it. */
  path?: string;
};

/** The gateway's denial vocabulary (design §3.6). A 401 without it is not the gateway. */
export const PHASE2_RESTRICTED_PREFIX = "restricted:";

/** The server's own `409` sentence for a closed window (§4.4), quoted unchanged. */
export const PHASE2_WINDOW_CLOSED_REASON = "no maintenance window is open";

/**
 * The probe's parsed `schema` field, or `null` when the body is absent, empty,
 * not JSON, or not an object. A 200 that is not JSON is how a static host answers
 * an API path with the app shell, and that must not read as `ready`.
 */
export function probeBodySchema(probe: Phase2Probe): string | null {
  if (typeof probe.body !== "string") return null;
  const text = probe.body.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const schema = (parsed as { schema?: unknown }).schema;
  return typeof schema === "string" ? schema : null;
}

/** Does the reply body carry the gateway's `restricted:` vocabulary? */
export function probeBodyIsRestricted(probe: Phase2Probe): boolean {
  return (
    typeof probe.body === "string" &&
    probe.body.includes(PHASE2_RESTRICTED_PREFIX)
  );
}

/**
 * The four-row table of §8, as code. The order of the checks matters only in that
 * no two rows can be true at once: a status is one number, and `ready` additionally
 * requires the body to be the change-log envelope.
 */
export function classifyPhase2Readiness(probe: Phase2Probe): Phase2Readiness {
  // No reply at all: a network error. §8 row 4.
  if (probe.status === null) return "unknown";
  // The gateway's `/api/` fallback: the route does not exist. §8 row 1.
  if (probe.status === 501) return "absent";
  // Mounted and failing closed — but only when the refusal is the gateway's own.
  // A 401 with an HTML body is a proxy's login page, not this surface. §8 row 2.
  if (probe.status === 401) {
    return probeBodyIsRestricted(probe) ? "mounted_closed" : "unknown";
  }
  // The one positive answer, and it names the envelope AND its version. §8 row 3.
  if (probe.status === 200) {
    return probeBodySchema(probe) === PHASE2_SCHEMA.changes
      ? "ready"
      : "unknown";
  }
  // 403, 404, 500, 503, a 200 of the wrong schema, HTML, an unparsable body:
  // nothing here is a state this console is willing to act on.
  return "unknown";
}

/**
 * The operator sentence for a readiness state. This is the ONE place the console
 * explains itself, so the `absent` line is the design's own words (§8) and the
 * `mounted_closed` line names the missing precondition (P-1) rather than saying
 * "closed", which would send an operator looking for a switch that does not exist.
 */
export function readinessReason(state: Phase2Readiness): string {
  switch (state) {
    case "absent":
      return "the IdP admin surface is not mounted on this deployment";
    case "mounted_closed":
      return "the surface is mounted and fails closed: layer 1b (npub to principal) is still a stub, so no caller can be resolved yet";
    case "ready":
      return "the change log answered with schema idp.changes.v1, so the surface is mounted and this caller is resolved";
    case "unknown":
      return "the readiness probe did not answer in a state this console recognizes, so nothing is claimed about the surface";
  }
}

/**
 * A one-line description of what the probe actually saw, for the notice. It
 * quotes the service (or the transport) rather than summarizing it, so a reader
 * can tell a 501 from a 401 from an HTML page.
 */
export function probeEvidence(probe: Phase2Probe): string {
  const parts: string[] = [];
  parts.push(probe.status === null ? "no HTTP status" : `HTTP ${probe.status}`);
  if (probe.path) parts.push(`read ${probe.path}`);
  const schema = probeBodySchema(probe);
  if (schema) parts.push(`schema "${schema}"`);
  if (probeBodyIsRestricted(probe)) parts.push('body carries "restricted:"');
  if (probe.transportError) parts.push(`transport: ${probe.transportError}`);
  if (!probe.body && !probe.transportError) parts.push("no body");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The controls, and the one gate that decides whether one may be enabled
// ---------------------------------------------------------------------------

export type Phase2ControlId = "create" | "patch" | "apply" | "changes";

/**
 * One control per endpoint of §3. `needsWindow` is the precondition §8 names:
 * the three writing endpoints require an open maintenance window, and the
 * change-log READ does not — a read is not a change, and disabling it for a
 * closed window would hide the very log an operator opens to decide whether to
 * open one.
 */
export type Phase2ControlDefinition = {
  id: Phase2ControlId;
  label: string;
  method: "GET" | "POST" | "PATCH";
  /** The path template, exactly as the design writes it. Display only. */
  template: string;
  needsWindow: boolean;
  /** Every mutating endpoint requires the header (§4.1); the read does not. */
  needsIdempotencyKey: boolean;
  summary: string;
};

export const PHASE2_CONTROLS: readonly Phase2ControlDefinition[] = [
  {
    id: "create",
    label: "Create client",
    method: "POST",
    template: "/api/idp/clients",
    needsWindow: true,
    needsIdempotencyKey: true,
    summary:
      "Plans a new client from a structured object. A create never adopts an existing client_id: a collision is a 409.",
  },
  {
    id: "patch",
    label: "Modify client",
    method: "PATCH",
    template: "/api/idp/clients/{client_id}",
    needsWindow: true,
    needsIdempotencyKey: true,
    summary:
      "Plans a change to one client. Rotation-class fields and consent_mode are refused on a modify.",
  },
  {
    id: "apply",
    label: "Apply change",
    method: "POST",
    template: "/api/idp/clients/{client_id}/apply",
    needsWindow: true,
    needsIdempotencyKey: true,
    summary:
      "Runs the privileged applier for one client. It restarts the identity provider, and the change log records the backup path so an operator can roll back.",
  },
  {
    id: "changes",
    label: "Read change log",
    method: "GET",
    template: "/api/idp/changes",
    needsWindow: false,
    needsIdempotencyKey: false,
    summary:
      "Reads the change history of the clients this caller's organizations own. A read, so it needs no window and changes nothing.",
  },
];

export type Phase2ControlView = {
  /** `false` means: render nothing at all for this control. */
  visible: boolean;
  /** A control may be enabled ONLY when this is true. */
  enabled: boolean;
  /** Shown next to the control when it is disabled. Never empty for a visible disabled control. */
  reason: string;
};

/**
 * THE GATE. One function, all four controls, so "why is this button dead" has one
 * answer and cannot drift per component.
 *
 * The rule, in the order §8 states it:
 *   1. readiness `absent` or `unknown` -> NOT RENDERED (the probe could not even
 *      say the route exists; a disabled button still asserts that it does);
 *   2. any other state that is not `ready` -> visible and disabled, with the
 *      readiness sentence as the reason;
 *   3. `ready` but the control's precondition is unmet -> visible and disabled,
 *      with the SERVER'S OWN sentence (`no maintenance window is open`), so the
 *      console and the eventual 409 say the same words;
 *   4. otherwise -> enabled. Nothing else in this feature may enable a control.
 */
export function phase2ControlState(
  control: Pick<Phase2ControlDefinition, "needsWindow">,
  readiness: Phase2Readiness,
  windowOpen: boolean,
): Phase2ControlView {
  if (readiness === "absent" || readiness === "unknown") {
    return { visible: false, enabled: false, reason: "" };
  }
  if (readiness !== "ready") {
    return {
      visible: true,
      enabled: false,
      reason: readinessReason(readiness),
    };
  }
  if (control.needsWindow && !windowOpen) {
    return {
      visible: true,
      enabled: false,
      reason: PHASE2_WINDOW_CLOSED_REASON,
    };
  }
  return { visible: true, enabled: true, reason: "" };
}
