/// <reference types="vite/client" />

/**
 * Build-time configuration this app reads. All OIDC values have production
 * defaults in `shared/lib/oidc-config.ts`, so a plain `vite build` produces a
 * working client for `https://agents.vclawhub.com` — see that file for the
 * override rules. Set them in an untracked `.env.local` or on the build
 * command line: `VITE_OIDC_ISSUER=… pnpm --filter buzz-web build`.
 */
interface ImportMetaEnv {
  /** Relay WebSocket URL. Unset in production: derived from window.location. */
  readonly VITE_RELAY_URL?: string;
  /** OIDC issuer (default https://auth.vclawhub.com). */
  readonly VITE_OIDC_ISSUER?: string;
  /** Public OIDC client id (default buzz-web). */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** Registered redirect URI (default `${window.location.origin}/auth/callback`). */
  readonly VITE_OIDC_REDIRECT_URI?: string;
  /**
   * Relay credential: `nip98` (default) or `oidc` (dormant; the gateway cannot
   * verify an OIDC bearer token yet — shared/lib/relay-auth.ts).
   */
  readonly VITE_RELAY_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
