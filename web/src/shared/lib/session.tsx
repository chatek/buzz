/**
 * React session layer over `./oidc.ts`.
 *
 * Exposes ONE identity to the UI: `status` (unknown / anonymous /
 * authenticated), the `principal`, and the access token. The principal comes
 * from the id_token payload decoded IN THE BROWSER — it is DISPLAY ONLY and
 * must never gate an action; see the TRUST note in `./oidc.ts`.
 *
 * Token policy (sessionStorage, absolute 12 h cap, single-use PKCE flow) is
 * documented in `./oidc.ts` — this file adds no storage of its own.
 */

import * as React from "react";

import {
  type CompletedSignIn,
  completeAuthorizationCallback,
  createAuthorizationRequest,
  currentOidcConfig,
  getValidAccessToken,
  isExpired,
  type OidcSession,
  principalFromSession,
  readStoredSession,
  clearStoredSession,
  refreshSession,
  type SessionPrincipal,
  signOut as clearOidcSession,
} from "./oidc";

export type SessionStatus = "unknown" | "anonymous" | "authenticated";

export type SessionContextValue = {
  status: SessionStatus;
  /** Display-only identity; null unless `status === "authenticated"`. */
  principal: SessionPrincipal | null;
  /** Human-readable reason the last sign-in attempt failed. */
  error: string | null;
  /**
   * What the sign-in attempt is doing right now, when it is waiting on the
   * IdP (e.g. a visible retry after a timeout). `null` when nothing is known
   * — which is the normal case: the login path uses the baked endpoints and
   * makes no request before it redirects.
   */
  progress: string | null;
  /** Start the PKCE flow; navigates away and does not resolve. */
  signIn(options?: { returnTo?: string; prompt?: string }): Promise<void>;
  /** Finish the PKCE flow from `/auth/callback`. Rejects on failure. */
  completeSignIn(params: {
    code: string;
    state: string;
  }): Promise<CompletedSignIn>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string | null>;
};

const SessionContext = React.createContext<SessionContextValue | null>(null);

function messageOf(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return "Sign-in failed.";
}

/** Where to land after sign-in: this page, unless it is part of the flow. */
function defaultReturnTo(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  const { pathname, search } = window.location;
  if (pathname === "/login" || pathname.startsWith("/auth/")) {
    return "/";
  }
  return `${pathname}${search}`;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<SessionStatus>("unknown");
  const [principal, setPrincipal] = React.useState<SessionPrincipal | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);

  const applySession = React.useCallback((session: OidcSession | null) => {
    if (session) {
      setPrincipal(principalFromSession(session));
      setStatus("authenticated");
    } else {
      setPrincipal(null);
      setStatus("anonymous");
    }
  }, []);

  // Restore on mount: a stored session survives a reload within the tab.
  React.useEffect(() => {
    let active = true;
    const restore = async () => {
      const session = readStoredSession();
      if (!session) {
        if (active) {
          applySession(null);
        }
        return;
      }
      if (!isExpired(session.tokens.expiresAt)) {
        if (active) {
          applySession(session);
        }
        return;
      }
      if (!session.tokens.refreshToken) {
        clearStoredSession();
        if (active) {
          applySession(null);
        }
        return;
      }
      try {
        const refreshed = await refreshSession();
        if (active) {
          applySession(refreshed);
        }
      } catch {
        clearStoredSession();
        if (active) {
          applySession(null);
        }
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [applySession]);

  const signIn = React.useCallback(
    async (options?: { returnTo?: string; prompt?: string }) => {
      setError(null);
      setProgress(null);
      try {
        const request = await createAuthorizationRequest(currentOidcConfig(), {
          returnTo: options?.returnTo ?? defaultReturnTo(),
          prompt: options?.prompt,
          // VISIBLE, NOT SILENT: the retry after a timeout is reported here
          // (the login button shows it) and logged by `oidc.ts`.
          onProgress: (event) => {
            setProgress(
              event.phase === "retry"
                ? `The identity provider did not answer within ${Math.round(
                    event.timeoutMs / 1_000,
                  )} s. Retrying (attempt ${event.attempt + 1} of ${event.attempts})…`
                : `Contacting the identity provider… (attempt ${event.attempt} of ${event.attempts})`,
            );
          },
        });
        window.location.assign(request.url);
      } catch (cause) {
        setProgress(null);
        setError(messageOf(cause));
      }
    },
    [],
  );

  const completeSignIn = React.useCallback(
    async (params: { code: string; state: string }) => {
      try {
        const completed = await completeAuthorizationCallback(params);
        applySession(completed.session);
        setError(null);
        return completed;
      } catch (cause) {
        setProgress(null);
        setError(messageOf(cause));
        throw cause;
      }
    },
    [applySession],
  );

  const signOut = React.useCallback(async () => {
    await clearOidcSession();
    applySession(null);
    setError(null);
    setProgress(null);
  }, [applySession]);

  const value = React.useMemo<SessionContextValue>(
    () => ({
      status,
      principal,
      error,
      progress,
      signIn,
      completeSignIn,
      signOut,
      getAccessToken: getValidAccessToken,
    }),
    [status, principal, error, progress, signIn, completeSignIn, signOut],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export type { SessionPrincipal };

export function useSession(): SessionContextValue {
  const value = React.useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside <SessionProvider>.");
  }
  return value;
}
