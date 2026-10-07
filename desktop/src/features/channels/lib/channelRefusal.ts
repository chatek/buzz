/**
 * Channel-read refusal classification — CHANNELS ALPHA §3 (D1), ruled 2026-10-06
 * (`dash-app/docs/CHANNELS_ALPHA_DEFINITION.md`, commit d9b7498a).
 *
 * The relay refuses a non-member's read of a PRIVATE channel with the wire
 * string below (HTTP `/query` → `403 {"error": "restricted: not a channel
 * member"}`; WS REQ → `CLOSED` with the same message). The Rust HTTP bridge
 * wraps the body as `relay returned 403 Forbidden: <error>`, and the WS publish
 * path rejects with the bare reason — so the matcher looks for the exact wire
 * phrase INSIDE the message, and no other error class contains it:
 * `restricted: channel access revoked`, `restricted: not a relay member`,
 * timeouts and rate limits are all DIFFERENT phrases and must keep their own
 * (existing) rendering. The ruled copy is therefore never shown for another
 * error class.
 *
 * The remaining §3 states are not refusals and are rendered by their own
 * surfaces, not here: non-member of an OPEN channel is a 200 read-only view
 * (ChannelPane's non-member banner, no join affordance), and an unknown
 * channel id is 200-empty by design and renders as does-not-exist
 * (ChannelRouteScreen's unresolved-channel view).
 */

/** The one wire refusal this module knows (§3, D1). */
export const CHANNEL_PRIVATE_REFUSAL_WIRE = "restricted: not a channel member";

/** The ruled copy for the private-channel refusal (§3, D1) — verbatim. */
export const CHANNEL_PRIVATE_REFUSAL_COPY =
  "This channel is private. Ask a segment admin for access.";

export type ChannelReadRefusalKind = "private-membership" | null;

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  return "";
}

/**
 * Whether an error message carries the §3 private-channel wire refusal.
 * Exact-phrase containment: works for the bare WS string and for the
 * Rust-wrapped HTTP form, and cannot match another refusal class.
 */
export function isChannelPrivateRefusal(message: unknown): boolean {
  return messageText(message).includes(CHANNEL_PRIVATE_REFUSAL_WIRE);
}

/** Classify a channel read/send error for rendering (null = not a refusal). */
export function channelRefusalKind(message: unknown): ChannelReadRefusalKind {
  return isChannelPrivateRefusal(message) ? "private-membership" : null;
}

/**
 * The text to render for a failed channel READ. A refusal renders the ruled
 * copy and nothing else (never a raw relay string); any other error keeps
 * today's message so connectivity/auth classes stay diagnosable.
 */
export function formatChannelReadError(message: unknown): string {
  if (isChannelPrivateRefusal(message)) {
    return CHANNEL_PRIVATE_REFUSAL_COPY;
  }
  const text = messageText(message).trim();
  return text.length > 0 ? text : "Could not load this channel.";
}

/**
 * The text to render for a failed channel SEND. A refusal renders the ruled
 * copy (the sender is not a member of a private channel — the fix is access,
 * not a retry); other errors keep the composer's existing wording.
 */
export function formatChannelSendError(
  error: unknown,
  fallback = "Unknown error",
): string {
  if (isChannelPrivateRefusal(error)) {
    return CHANNEL_PRIVATE_REFUSAL_COPY;
  }
  const text = messageText(error).trim();
  return `Message failed to send: ${text.length > 0 ? text : fallback}`;
}
