import { appApiRoute } from "@/lib/plugins/api-auth";
import { orders } from "@/lib/plugins/api-reads";
// API v1 for custom apps (Phase 4 line 4, docs/APPS_API.md). Bearer token
// only (lib/plugins/api-auth.js), GET only, no CORS headers; every call is
// audited before it is answered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// orders.read: orders, newest first, never a customer field (?status= filters)
export const GET = appApiRoute("orders.read", (request) => orders(request));
