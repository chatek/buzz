import { Outlet, createRootRoute } from "@tanstack/react-router";

import { AccountControl } from "@/features/auth/ui/AccountControl";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* The app previously had no chrome at all: this header is the human
          identity surface (sign in / signed in as … / sign out). */}
      <header className="flex h-12 shrink-0 items-center justify-end gap-3 border-b border-black/5 px-4 dark:border-white/10">
        <AccountControl />
      </header>
      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
