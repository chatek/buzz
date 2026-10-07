/**
 * CHANNELS ALPHA affordance verdicts — operator-ruled 2026-10-06 (D1–D7),
 * spec `dash-app/docs/CHANNELS_ALPHA_DEFINITION.md` §7 (commit d9b7498a).
 *
 * House convention: HIDDEN ≠ DELETED. Each `false` below switches off an
 * affordance at its render sites; the components, hooks and wire kinds stay
 * intact so a verdict reversal is a one-line flip. Every render site that
 * consults one of these flags carries a marker comment naming the ruling.
 *
 * RULING C(i) (CHANNELS_SERVICE_ACL.md §5, commit feaa8054): this table is the
 * FALLBACK. The primary source is the relay's NIP-11 `channels` capability set,
 * fetched once per community connect (`relayChannelCaps.ts`) — "turn DMs on for
 * this segment" is a server config change, not a desktop release. Render sites
 * therefore read the DERIVED set through `useChannelsAlphaAffordances()`
 * (relayChannelCaps.ts), not this constant; with the field absent — or
 * malformed, or the relay unreachable — the derived set is this table verbatim,
 * so today's behaviour is byte-identical.
 */
export const CHANNELS_ALPHA_AFFORDANCES = {
  /**
   * §1/§7 DMs are IN — primary. The human↔agent DM is the new user's first
   * surface and stays reachable everywhere (empty workspace, roster, DM list).
   */
  directMessages: true,
  /** §7 HIDE: sidebar sections (unused on the live profile; zero keys). */
  sections: false,
  /** §7 HIDE: channel stars (unused on the live profile; zero keys). */
  stars: false,
  /** §7 HIDE: channel mutes (unused on the live profile; zero keys). */
  mutes: false,
  /** §7 HIDE: sidebar sort mode picker (unused on the live profile; zero keys). */
  sort: false,
  /** §7 HIDE: channel templates (no writer exists on either side). */
  templates: false,
  /** §7 HIDE: canvases (no writer exists on either side). */
  canvases: false,
} as const;

export type ChannelAlphaAffordance = keyof typeof CHANNELS_ALPHA_AFFORDANCES;

/**
 * The full affordance set: every key present, frozen, readonly.
 *
 * ⚠ TYPED AS `boolean`, NOT as the fallback's literal `true`/`false`. The first
 * remote build of the C(i) consumer FAILED on exactly this
 * (channelsAlphaAffordances.ts(112,3) error TS2322): `typeof
 * CHANNELS_ALPHA_AFFORDANCES` gives the LITERAL types, and spreading the
 * server's Partial<Record<..., boolean>> widens `directMessages` to `boolean`,
 * which is not assignable to `true`. The workstation's tsc accepted it and the
 * build host's did not — a type error that only a build caught, which is why
 * the artefact step exists. The fallback const keeps its literals (they are
 * assignable to boolean); only the SET's type widens.
 */
export type ChannelAlphaAffordanceSet = Readonly<Record<ChannelAlphaAffordance, boolean>>;

/**
 * The subset the server may state. Built ONLY by `parseChannelsCapabilities`,
 * so unknown keys, non-boolean values and malformed documents can never reach
 * a render site through this type.
 */
export type ServerChannelCapabilities = Partial<
  Record<ChannelAlphaAffordance, boolean>
>;

/**
 * NIP-11 `channels` wire key → affordance key. The wire spells DMs `dm`
 * (`internal/nip01/server.go` ChannelCapabilities — field names are WIRE
 * CONTRACT); the client's table predates the ruling and says `directMessages`.
 * `agent_activity` is deliberately absent: the server advertises it as
 * deferred|on|off (a tri-state, not an affordance) and no client surface
 * consumes it yet — UNKNOWN, named, not invented.
 */
const WIRE_KEY_TO_AFFORDANCE = {
  dm: "directMessages",
  sections: "sections",
  stars: "stars",
  mutes: "mutes",
  sort: "sort",
  templates: "templates",
  canvases: "canvases",
} as const satisfies Record<string, ChannelAlphaAffordance>;

/**
 * Parse the NIP-11 `channels` capability field DEFENSIVELY (RULING C(i)).
 *
 *   absent / not an object  → null (whole table falls back)
 *   malformed VALUE         → that key falls back (never invented)
 *   unknown key             → ignored
 *   partial object          → only the known boolean keys it carries
 *
 * Never throws, never coerces: a value that is not exactly a boolean is not a
 * verdict, and an absent verdict is the compile-time table's to give.
 */
export function parseChannelsCapabilities(
  raw: unknown,
): ServerChannelCapabilities | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  let parsed: ServerChannelCapabilities | null = null;
  for (const [wireKey, affordance] of Object.entries(WIRE_KEY_TO_AFFORDANCE)) {
    const value = record[wireKey];
    if (typeof value === "boolean") {
      parsed ??= {};
      parsed[affordance] = value;
    }
  }
  return parsed;
}

/**
 * Derive the effective affordance set: every key the server stated wins, every
 * key it did not (or could not) state keeps the compile-time verdict.
 * `null` returns THE fallback object itself, so the absent-field render is
 * byte-identical to the pre-C(i) build, not merely deeply-equal.
 */
export function deriveChannelsAlphaAffordances(
  server: ServerChannelCapabilities | null,
): ChannelAlphaAffordanceSet {
  if (!server) {
    return CHANNELS_ALPHA_AFFORDANCES;
  }
  return Object.freeze({
    ...CHANNELS_ALPHA_AFFORDANCES,
    ...server,
  });
}
