import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";

import buzzAppIcon from "@/assets/app-icon@3x.png";
import { useSession } from "@/shared/lib/session";
import { Button } from "@/shared/ui/button";

type CallbackSearch = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};

/**
 * Authorization response handler (`/auth/callback`) — the registered redirect
 * URI of the public `buzz-web` client.
 *
 * FAIL CLOSED: a missing `code`/`state`, an IdP-reported `error`, or a `state`
 * that does not match the flow this tab started results in an error page and
 * NO token request. `state`/`nonce`/PKCE verification lives in
 * `shared/lib/oidc.ts` (`completeAuthorizationCallback`), not here.
 */
export const Route = createFileRoute("/auth/callback")({
  validateSearch: (search: Record<string, unknown>): CallbackSearch => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    error_description:
      typeof search.error_description === "string"
        ? search.error_description
        : undefined,
  }),
  component: AuthCallbackPage,
});

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

function AuthCallbackPage() {
  const { completeSignIn } = useSession();
  const search = Route.useSearch();
  const [failure, setFailure] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    const { code, state, error, error_description: detail } = search;
    if (error) {
      setFailure(
        `The identity provider refused the sign-in (${error})${
          detail ? `: ${detail}` : "."
        } Nothing was stored.`,
      );
      return;
    }
    if (!code || !state) {
      setFailure(
        "This sign-in response is incomplete: it carries no code or no state, so nothing was stored. Start again from the sign-in button.",
      );
      return;
    }
    completeSignIn({ code, state })
      .then((completed) => {
        window.location.replace(completed.returnTo ?? "/");
      })
      .catch((cause: unknown) => {
        setFailure(
          cause instanceof Error
            ? cause.message
            : "Sign-in failed. Nothing was stored.",
        );
      });
  }, [completeSignIn, search]);

  if (!failure) {
    return (
      <Shell title="Signing you in…">
        <p
          className="mt-2 text-sm text-black/60 dark:text-white/60"
          role="status"
        >
          Verifying the response from the vclaw identity provider.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Sign-in failed">
      <p className="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">
        {failure}
      </p>
      <div className="mt-6 w-full max-w-xs space-y-2">
        <Button
          asChild
          className="h-10 w-full bg-black text-white hover:bg-black/90 focus-visible:ring-black dark:bg-white dark:text-black dark:hover:bg-white/90"
        >
          <Link to="/login">Try again</Link>
        </Button>
        <Link
          className="block text-sm text-black/60 underline-offset-4 hover:text-black hover:underline dark:text-white/60 dark:hover:text-white"
          to="/"
        >
          Back to Buzz
        </Link>
      </div>
    </Shell>
  );
}
