import { UserRound } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { OIDC_LOGIN_PATH } from "@/shared/lib/oidc-config";
import { type SessionPrincipal, useSession } from "@/shared/lib/session";
import { Button } from "@/shared/ui/button";

/**
 * Sign-in entry, signed-in identity, and sign-out — the whole human-facing
 * identity surface. The identity shown is display-only (id_token claims
 * decoded in the browser, never verified here); it gates nothing.
 */
export function AccountControl({
  className,
  align = "end",
}: {
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const { status, principal, signOut } = useSession();
  const [signingOut, setSigningOut] = React.useState(false);

  const aligned =
    align === "end"
      ? "justify-end"
      : align === "start"
        ? "justify-start"
        : "justify-center";

  if (status === "unknown") {
    return null;
  }

  if (status === "anonymous" || !principal) {
    return (
      <div className={cn("flex items-center gap-2", aligned, className)}>
        <Button
          asChild
          className="bg-black text-white hover:bg-black/90 focus-visible:ring-black dark:bg-white dark:text-black dark:hover:bg-white/90 dark:focus-visible:ring-white"
          size="sm"
        >
          <a href={OIDC_LOGIN_PATH}>
            <UserRound className="h-4 w-4" />
            Sign in with vclaw
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", aligned, className)}>
      <span
        className="flex min-w-0 items-center gap-1.5 text-xs text-black/60 dark:text-white/60"
        title={principal.subject}
      >
        <UserRound className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{principalLabel(principal)}</span>
      </span>
      <Button
        className="shrink-0 text-black/70 hover:text-black dark:text-white/70 dark:hover:text-white"
        disabled={signingOut}
        size="sm"
        variant="ghost"
        onClick={() => {
          setSigningOut(true);
          void signOut().finally(() => setSigningOut(false));
        }}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}

/** Prefer a human-readable claim; fall back to the subject. */
export function principalLabel(principal: SessionPrincipal): string {
  return (
    principal.email ??
    principal.preferredUsername ??
    principal.name ??
    principal.subject
  );
}
