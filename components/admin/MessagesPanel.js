import { Card, CardHeader } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { EmptyState } from "@/components/console/bits";

// Messages & notifications panel (S39 / BE23 + SF15, redesigned S50). SERVER
// component — rendered on the Integrations page with pre-fetched data. The
// notification list is the delivery truth (queued | sent | failed, provider
// errors shown); the contact inbox pairs each shopper message with its
// merchant-notify state.

const NOTIFICATION_COLUMNS = [
  { key: "status", header: "Status", width: "5.5rem" },
  { key: "type", header: "Type", width: "7rem" },
  { key: "subject", header: "Subject" },
  { key: "recipient", header: "Recipient" },
];

const deliveryChip = (status) =>
  status === "failed" ? (
    <Badge tone="warning" title="failed">
      Delivery failed
    </Badge>
  ) : (
    <StatusBadge status={status || "stored"} />
  );

export default function MessagesPanel({ messages, notifications }) {
  return (
    <div className="mt-8 space-y-4">
      <Card>
        <CardHeader
          title="Contact inbox"
          description="Messages from the storefront contact form. Each also goes to your support email — the badge is that delivery's honest state."
        />
        {messages.length === 0 ? (
          <EmptyState title="No messages yet" body="Shopper messages from the contact form land here." className="py-6" />
        ) : (
          <ul className="space-y-3">
            {messages.map((m) => (
              <li key={m.id} className="rounded-ctl border border-edge bg-surface p-3.5 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{m.name}</span>
                  <a href={`mailto:${m.email}`} className="rounded text-xs text-fg-muted focus-ring hover:text-fg hover:underline">
                    {m.email}
                  </a>
                  {deliveryChip(m.notify_status)}
                  <span className="ml-auto text-xs text-fg-subtle">{new Date(m.created_at).toLocaleString("en-IN")}</span>
                </p>
                <p className="mt-1.5 whitespace-pre-line text-fg-muted">{m.message}</p>
                {m.notify_error && <p className="mt-1 text-xs text-danger">{m.notify_error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Notification log"
          description="Every outbound message this store queued (BE23): durable, retried with backoff, never silently lost."
        />
        <Table
          columns={NOTIFICATION_COLUMNS}
          rows={notifications}
          dense
          empty={<EmptyState title="Nothing queued yet" className="py-6" />}
          renderCell={(n, col) => {
            switch (col.key) {
              case "status":
                return <StatusBadge status={n.status} />;
              case "type":
                return <Badge tone="neutral">{n.type}</Badge>;
              case "subject":
                return (
                  <span className="block min-w-0">
                    <span className="block max-w-72 truncate text-fg" title={n.subject}>
                      {n.subject}
                    </span>
                    {n.provider_id === "mock" && (
                      <Badge tone="warning" title="mail provider not configured — nothing was actually sent" className="mt-0.5">
                        Dev mock
                      </Badge>
                    )}
                    {n.error && n.provider_id !== "mock" && <span className="mt-0.5 block text-xs text-danger">{n.error}</span>}
                  </span>
                );
              case "recipient":
                return <span className="text-xs text-fg-muted">{n.recipient || "(no recipient)"}</span>;
              default:
                return n[col.key];
            }
          }}
        />
      </Card>
    </div>
  );
}
