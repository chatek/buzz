/**
 * THE SEAM: how a browser session's OIDC credential reaches the relay.
 *
 * Today the relay accepts exactly two credentials and neither is an OIDC
 * token: NIP-42 on the WebSocket and NIP-98 on protected HTTP
 * (`Authorization: Nostr <base64 kind:27235>`). The NIP-FI design
 * (`vendors/buzz/docs/nips/NIP-FI.md`) adds a third — an issuer-qualified
 * assertion in `Nostr-Federated-Identity: Bearer <JWS>` — and
 * `115-OIDC-FORK-PLAN.md` §6.B/§6.D is the plan for making the gateway verify
 * it. NONE of that exists in the deployed gateway, so this module keeps
 * NIP-98 as the default and treats the bearer paths as dormant:
 *
 * TODO(115-OIDC-FORK-PLAN.md §6.B "B2. Transport" + §6.D "D1. The one seam"):
 *   1. vgate mints the assertion (§6.A) — `POST /v1/buzz/assertions`, which
 *      today returns nothing because the endpoint does not exist.
 *   2. the gateway learns to verify it offline against per-issuer JWKS (§6.B1)
 *      and to resolve a same-origin session cookie for browser WS upgrades
 *      (§6.B2/B3) — a browser cannot set a header on a WebSocket upgrade.
 *   3. ONLY THEN may `VITE_RELAY_CREDENTIAL=oidc` stop being a switch nobody
 *      should flip: until the gateway verifies it, sending `Bearer` there is a
 *      guaranteed 401, which is why the default path stays NIP-98.
 */

import { makeNip98AuthHeader } from "./nip98";
import { getValidAccessToken } from "./oidc";

/**
 * NIP-FI's client-attached header name, byte-for-byte what the verifier
 * expects (`CLIENT_ATTACHED_HEADER` in
 * `crates/buzz-auth/src/nip_fi/config.rs`).
 */
export const NIP_FI_ASSERTION_HEADER = "Nostr-Federated-Identity";

export type RelayCredentialMode = "nip98" | "oidc";

/**
 * Which credential a relay HTTP call carries. DEFAULT `nip98`.
 * `import.meta.env.VITE_RELAY_CREDENTIAL === "oidc"` selects the OIDC headers
 * for local experiments against a gateway that can verify them.
 */
export function relayCredentialMode(): RelayCredentialMode {
  return import.meta.env.VITE_RELAY_CREDENTIAL === "oidc" ? "oidc" : "nip98";
}

/**
 * The NIP-FI credential pair: the OIDC access token for the human session and,
 * when the issuer has minted one, the assertion that names the Nostr actor
 * key. Kept separate from NIP-98 so the two can never be confused.
 */
export function federatedIdentityHeaders(
  assertion: string | null | undefined,
): Record<string, string> {
  return assertion ? { [NIP_FI_ASSERTION_HEADER]: `Bearer ${assertion}` } : {};
}

export type RelayAuthHeaderOptions = {
  url: string;
  method: string;
  /** POST/PUT body, when the caller wants the NIP-98 payload digest. */
  body?: string;
  /** Durable-membership flows must sign with a NIP-07 extension. */
  requireNip07?: boolean;
  /**
   * NIP-FI assertion for the actor key, when one exists. Always null today:
   * no assertion issuer is deployed (115-OIDC-FORK-PLAN.md §6.A).
   */
  assertion?: string | null;
};

/**
 * Credential headers for a relay HTTP request.
 *
 * Default (`nip98`): exactly the header this app sent before OIDC existed —
 * no behaviour change, and `buildRelayAuthHeaders` is the single place to
 * change when the gateway gains a bearer path.
 */
export async function buildRelayAuthHeaders(
  options: RelayAuthHeaderOptions,
): Promise<Record<string, string>> {
  if (relayCredentialMode() === "oidc") {
    const accessToken = await getValidAccessToken();
    if (accessToken) {
      return {
        Authorization: `Bearer ${accessToken}`,
        ...federatedIdentityHeaders(options.assertion),
      };
    }
  }
  return {
    Authorization: await makeNip98AuthHeader(options.url, options.method, {
      body: options.body,
      requireNip07: options.requireNip07,
    }),
  };
}
