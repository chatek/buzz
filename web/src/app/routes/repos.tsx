import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/repos")({
  // A redirect must CARRY the query string, not rebuild a bare path: the readers
  // of `?preview=` switch on it (see features/repos/ui/ReposPage.tsx), so dropping
  // it here rendered the empty community state where a mock preview was asked for.
  component: () => <Navigate to="/" search={(prev) => prev} />,
});
