import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_PRIVATE_REFUSAL_COPY,
  CHANNEL_PRIVATE_REFUSAL_WIRE,
  channelRefusalKind,
  formatChannelReadError,
  formatChannelSendError,
  isChannelPrivateRefusal,
} from "./channelRefusal.ts";

// ── §3 D1: the private-channel refusal is matched on the WIRE phrase ────────

test("isChannelPrivateRefusal: matches the bare WS CLOSED string", () => {
  assert.equal(isChannelPrivateRefusal(CHANNEL_PRIVATE_REFUSAL_WIRE), true);
});

test("isChannelPrivateRefusal: matches the Rust-wrapped HTTP 403 form", () => {
  // relay.rs relay_error_message formats the 403 body as
  // `relay returned {status}: {error}`.
  assert.equal(
    isChannelPrivateRefusal(
      `relay returned 403 Forbidden: ${CHANNEL_PRIVATE_REFUSAL_WIRE}`,
    ),
    true,
  );
  assert.equal(
    isChannelPrivateRefusal(
      new Error(
        `relay returned 403 Forbidden: ${CHANNEL_PRIVATE_REFUSAL_WIRE}`,
      ),
    ),
    true,
  );
});

test("isChannelPrivateRefusal: never matches another error class", () => {
  // Sibling refusal classes from relayClosedPolicy — all DIFFERENT wire phrases.
  for (const message of [
    "restricted: channel access revoked",
    "restricted: not a relay member",
    "restricted: not authorized",
    "blocked: banned",
    "invalid: malformed filter",
    "rate-limited: quota exceeded; retry in 4s",
    "relay unreachable: request timed out",
    "relay rate-limited: retry in 3s",
    "channel members not found",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isChannelPrivateRefusal(message), false, String(message));
  }
});

test("channelRefusalKind: private-membership only for the wire refusal", () => {
  assert.equal(
    channelRefusalKind(CHANNEL_PRIVATE_REFUSAL_WIRE),
    "private-membership",
  );
  assert.equal(
    channelRefusalKind("relay unreachable: request timed out"),
    null,
  );
  assert.equal(channelRefusalKind(new Error("server shutting down")), null);
});

// ── rendering: the ruled copy, never the raw string ──────────────────────────

test("formatChannelReadError: refusal renders the ruled copy verbatim", () => {
  assert.equal(
    formatChannelReadError(
      `relay returned 403 Forbidden: ${CHANNEL_PRIVATE_REFUSAL_WIRE}`,
    ),
    CHANNEL_PRIVATE_REFUSAL_COPY,
  );
  // The raw wire string must not appear anywhere in the rendered text.
  assert.equal(
    formatChannelReadError(CHANNEL_PRIVATE_REFUSAL_WIRE).includes(
      "restricted:",
    ),
    false,
  );
});

test("formatChannelReadError: other errors keep their message", () => {
  assert.equal(
    formatChannelReadError("relay unreachable: request timed out"),
    "relay unreachable: request timed out",
  );
});

test("formatChannelSendError: refusal renders the ruled copy", () => {
  assert.equal(
    formatChannelSendError(CHANNEL_PRIVATE_REFUSAL_WIRE),
    CHANNEL_PRIVATE_REFUSAL_COPY,
  );
});

test("formatChannelSendError: other errors keep the composer wording", () => {
  assert.equal(
    formatChannelSendError(new Error("Timed out while sending the message.")),
    "Message failed to send: Timed out while sending the message.",
  );
  assert.equal(
    formatChannelSendError(undefined),
    "Message failed to send: Unknown error",
  );
});
