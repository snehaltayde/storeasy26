import HandoffSignIn from "@/components/admin/HandoffSignIn";

// Phase 1 line 1: a new founder arrives here from signup with a single-use
// sign-in token in the URL fragment (#t=…), which never reaches a server log
// or a Referer. The page posts it to /api/admin/handoff and goes on.
export const dynamic = "force-dynamic";
export const metadata = { title: "Signing you in", robots: { index: false }, referrer: "no-referrer" };

export default function AdminHandoffPage() {
  return <HandoffSignIn />;
}
