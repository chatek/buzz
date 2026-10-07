/**
 * CHANNELS ALPHA affordance verdicts — operator-ruled 2026-10-06 (D1–D7),
 * spec `dash-app/docs/CHANNELS_ALPHA_DEFINITION.md` §7 (commit d9b7498a).
 *
 * House convention: HIDDEN ≠ DELETED. Each `false` below switches off an
 * affordance at its render sites; the components, hooks and wire kinds stay
 * intact so a verdict reversal is a one-line flip. Every render site that
 * consults one of these flags carries a marker comment naming the ruling.
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
