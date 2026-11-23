// lib/admin-auth.js as scripts/test-permissions.js sees it (route-harness
// spyOnRequireAdmin): the real module, with requireAdmin recording the action it
// is asked for in globalThis.__requireAdminSink when a suite has set one.
import * as real from "../../lib/admin-auth.js";

export * from "../../lib/admin-auth.js";

export async function requireAdmin(request, action) {
  globalThis.__requireAdminSink?.push(action);
  return real.requireAdmin(request, action);
}
