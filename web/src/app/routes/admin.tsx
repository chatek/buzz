/**
 * `/admin` — the identity-plane admin console (phase 1, read-only).
 *
 * WHY THIS FILE DOES NOT USE `createFileRoute`, which every other route here
 * does. MEASURED 2026-08-21-style check, re-run 2026-09-21 on this tree:
 * `createFileRoute("/admin")` fails to compile while the route is absent from
 * the generated tree —
 *
 *   src/app/routes/admin.tsx: error TS2345: Argument of type '"/admin"' is not
 *   assignable to parameter of type 'keyof FileRoutesByPath | undefined'.
 *
 * `FileRoutesByPath` is declared by the GENERATED `src/app/routeTree.gen.ts`,
 * which is produced from `src/app/routes.ts` — the one shared file this lane may
 * not edit (it has a single writer: the lead). So the route is built with the
 * code-based API, which is the same API the generator uses underneath
 * (`adminRouteImport.update({ id, path, getParentRoute })`), and which compiles
 * both before and after the registration line lands.
 *
 * The registration line itself, and the one-line change that turns this back
 * into `createFileRoute("/admin")` if the lead prefers it, are written down in
 * `.prime/handoff/idp-build/j18/CONSOLE_PHASE1.md`.
 */

import { createRoute } from "@tanstack/react-router";

import { AdminConsolePage } from "@/features/admin/ui/AdminConsolePage";
import { Route as rootRoute } from "./root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminConsolePage,
});
