import { index, route, rootRoute } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  index("index.tsx"),
  route("/login", "login.tsx"),
  route("/auth/callback", "auth.callback.tsx"),
  route("/invite/$code", "invite.$code.tsx"),
  route("/repos", "repos.tsx"),
  route("/repos/$repoId", "repos.$repoId.tsx"),
  route("/repos/$repoId/blob/$", "repos.$repoId.blob.$.tsx"),
  route("/admin", "admin.tsx"),
]);
