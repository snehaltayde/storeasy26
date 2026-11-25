import { appApiRoute } from "@/lib/plugins/api-auth";
import { me } from "@/lib/plugins/api-reads";
// API v1 for custom apps (Phase 4 line 4, docs/APPS_API.md). Bearer token
// only (lib/plugins/api-auth.js), GET only, no CORS headers; every call is
// audited before it is answered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// no scope: the app, its effective scopes and the store host
export const GET = appApiRoute(null, (_request, { app }) => me(app));
