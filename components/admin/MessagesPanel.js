// Messages & notifications panel (S39 / BE23 + SF15). SERVER component —
// rendered on the Integrations page with pre-fetched data. The notification
// list is the delivery truth (queued | sent | failed, provider errors shown);
// the contact inbox pairs each shopper message with its merchant-notify state.
const badge = (status) => {
  const map = {
    sent: "bg-lime-100 text-lime-700",
    queued: "bg-amber-100 text-amber-700",
    failed: "bg-red-100 text-red-600",
  };
  return map[status] || "bg-zinc-100 text-zinc-500";
};

export default function MessagesPanel({ messages, notifications }) {
  return (
    <div className="mt-8 space-y-5">
      <section className="rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Contact inbox</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Messages from the storefront contact form. Each also goes to your support email — the badge is that
          delivery&rsquo;s honest state.
        </p>
        <ul className="mt-3 divide-y divide-zinc-100">
          {messages.map((m) => (
            <li key={m.id} className="py-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{m.name}</span>
                <a href={`mailto:${m.email}`} className="text-xs text-lime-700 hover:underline">
                  {m.email}
                </a>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${badge(m.notify_status)}`}>{m.notify_status || "stored"}</span>
                <span className="ml-auto text-xs text-zinc-400">{new Date(m.created_at).toLocaleString("en-IN")}</span>
              </p>
              <p className="mt-1 whitespace-pre-line text-zinc-600">{m.message}</p>
              {m.notify_error && <p className="mt-1 text-xs text-red-500">{m.notify_error}</p>}
            </li>
          ))}
          {messages.length === 0 && <li className="py-6 text-center text-sm text-zinc-400">No messages yet.</li>}
        </ul>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Notification log</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Every outbound message this store queued (BE23): durable, retried with backoff, never silently lost.
        </p>
        <ul className="mt-3 divide-y divide-zinc-100">
          {notifications.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${badge(n.status)}`}>{n.status}</span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">{n.type}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-700">{n.subject}</span>
              <span className="text-xs text-zinc-400">→ {n.recipient || "(no recipient)"}</span>
              {n.provider_id === "mock" && <span className="text-[10px] font-bold text-amber-600" title="mail provider not configured — nothing was actually sent">DEV MOCK</span>}
              {n.error && n.provider_id !== "mock" && <span className="w-full text-xs text-red-500">{n.error}</span>}
            </li>
          ))}
          {notifications.length === 0 && <li className="py-6 text-center text-sm text-zinc-400">Nothing queued yet.</li>}
        </ul>
      </section>
    </div>
  );
}
