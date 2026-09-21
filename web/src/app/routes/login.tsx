import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";

import buzzAppIcon from "@/assets/app-icon@3x.png";
import { useSession } from "@/shared/lib/session";
import { Button } from "@/shared/ui/button";

type LoginSearch = { returnTo?: string };

/**
 * Sign-in entry point (`/login`).
 *
 * The vclaw IDP is the only identity source: Authorization Code + PKCE
 * against `https://auth.vclawhub.com` with the public `buzz-web` client.
 * See `dash/docs/sprint-buzz-swap/115-OIDC-FORK-PLAN.md` §6.C/§6.D.
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { status, principal, error, signIn } = useSession();
  const { returnTo } = Route.useSearch();
  const [starting, setStarting] = React.useState(false);

  const begin = () => {
    setStarting(true);
    void signIn({ returnTo });
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-[#F3F3F3] px-4 py-16 dark:bg-[#171717]">
      <div className="flex w-full max-w-md flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm sm:px-10">
        <div
          className="h-16 w-16 overflow-hidden bg-black"
          style={{ borderRadius: "22.37%" }}
        >
          <img alt="Buzz" className="h-full w-full" src={buzzAppIcon} />
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-black dark:text-white">
          Sign in to Buzz
        </h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-black/60 dark:text-white/60">
          Sign in with your vclaw account. Buzz uses the vclaw identity provider
          (Authelia) and never sees your password.
        </p>

        {status === "authenticated" ? (
          <p className="mt-6 text-sm text-black/70 dark:text-white/70">
            You are already signed in
            {principal?.email ? ` as ${principal.email}` : ""}.
          </p>
        ) : null}

        <div className="mt-6 w-full max-w-xs space-y-2">
          {status === "authenticated" ? (
            <Button
              asChild
              className="h-10 w-full bg-black text-white hover:bg-black/90 focus-visible:ring-black dark:bg-white dark:text-black dark:hover:bg-white/90"
            >
              <Link to="/">Continue to Buzz</Link>
            </Button>
          ) : (
            <Button
              className="h-10 w-full bg-black text-white hover:bg-black/90 focus-visible:ring-black disabled:cursor-not-allowed disabled:bg-black/30 disabled:text-white/70 dark:bg-white dark:text-black dark:hover:bg-white/90"
              disabled={starting || status === "unknown"}
              onClick={begin}
            >
              {starting ? "Redirecting…" : "Continue with vclaw"}
            </Button>
          )}
          <Link
            className="block text-sm text-black/60 underline-offset-4 hover:text-black hover:underline dark:text-white/60 dark:hover:text-white"
            to="/"
          >
            Back to Buzz
          </Link>
        </div>

        {error ? (
          <p
            className="mt-4 text-sm text-red-700 dark:text-red-400"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
