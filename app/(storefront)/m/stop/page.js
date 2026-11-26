import { verifyStopToken } from "@/lib/messaging/consent";
import { tfetch } from "@/lib/storefront-request";

// Phase 9 line 3: the opt-out link in every WhatsApp message. GET shows the
// choice; the button POSTs to /api/messaging/stop, which revokes. The signed
// token is the only proof and the page shows nothing about the person.
export const dynamic = "force-dynamic";
export const metadata = { title: "Stop WhatsApp messages", robots: { index: false } };

export default async function StopPage({ searchParams }) {
  const { t, done, bad } = await searchParams;
  const valid = !done && !bad && t ? Boolean(await tfetch(() => verifyStopToken(String(t)))) : false;
  return (
    <div className="mx-auto max-w-md px-4 py-16 sm:px-6" data-wa="stop">
      <div className="rounded-sf-card border border-sf-border p-6 sm:p-8">
        <h1 className="text-xl font-bold">WhatsApp messages</h1>
        {done ? (
          <p className="mt-3 text-sm text-sf-text-subtle" data-wa-stop="done">
            Done. We won&apos;t send you any more WhatsApp messages. You can turn them on again in your account or at checkout.
          </p>
        ) : valid ? (
          <form method="post" action="/api/messaging/stop" className="mt-3">
            <p className="text-sm text-sf-text-subtle">Stop all order updates, offers and cart reminders on WhatsApp from this store?</p>
            <input type="hidden" name="t" value={String(t)} />
            <button type="submit" data-wa-stop="confirm" className="sf-focus mt-6 min-h-11 w-full rounded-sf-control bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse transition hover:bg-sf-inverse-hover">
              Stop messages
            </button>
          </form>
        ) : (
          <p className="mt-3 text-sm text-sf-text-subtle" data-wa-stop="bad">
            This link has expired or isn&apos;t complete. Reply STOP to any of our WhatsApp messages, or turn messages off in your account.
          </p>
        )}
      </div>
    </div>
  );
}
