import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { approvalByToken, currentDraftHash } from "@/lib/platform/agency";
import { previewToken } from "@/lib/releases";
import { siteName } from "@/lib/site";
import ApprovalDecision from "@/components/ApprovalDecision";
import { tfetch } from "@/lib/tenant-request";
import { tenantId } from "@/lib/tenant-context";
import { Banner } from "@/components/console/Banner";
import { KeyValue } from "@/components/console/bits";

// Client review page (S48 / AG04, redesigned S50): a signed, expiring link
// an agency sends its client — a standalone centered document card. Shows
// exactly which draft (content hash) the decision covers, opens a private
// preview (existing signed preview cookie flow), and records the decision
// with the approver's typed identity. If the draft changed since the link
// was made, deciding is blocked — fresh link, fresh hash.
export const dynamic = "force-dynamic";
export const metadata = { title: "Review & approve", robots: { index: false } };

export default async function ApprovePage({ params }) {
  const { token } = await params;
  const data = await tfetch(async () => {
    const approval = await approvalByToken(token);
    if (!approval || approval.tenant_id !== tenantId()) return null;
    const stale = approval.status === "pending" ? (await currentDraftHash(approval.tenant_id)) !== approval.content_hash : false;
    const preview = approval.status === "pending" && !stale ? await previewToken() : null;
    return { approval, stale, preview, name: siteName() };
  });
  if (!data) notFound();
  const { approval, stale, preview, name } = data;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-14 sm:px-6">
      <main className="rounded-card border border-edge bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-medium text-fg-subtle">Design review · {name}</p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-fg">Your agency asked you to review a draft</h1>
        {approval.note && (
          <blockquote className="mt-3 border-l-2 border-edge-strong pl-3 text-sm text-fg-muted">“{approval.note}”</blockquote>
        )}

        <KeyValue
          className="mt-5"
          items={[
            { key: "Draft", value: approval.content_hash.slice(0, 12), mono: true },
            { key: "Link expires", value: new Date(approval.expires_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) },
          ]}
        />
        <p className="mt-3 text-xs text-fg-muted">
          This decision covers that draft hash only — if the design changes afterwards, a new review link is required.
        </p>

        {approval.status !== "pending" ? (
          <Banner tone={approval.status === "approved" ? "success" : "neutral"} className="mt-6">
            This request is <strong>{approval.status}</strong>
            {approval.approver ? ` by ${approval.approver}` : ""}
            {approval.decided_at ? ` on ${new Date(approval.decided_at).toLocaleDateString("en-IN")}` : ""}.
          </Banner>
        ) : stale ? (
          <Banner tone="warning" className="mt-6">
            The draft changed after this link was created, so deciding here is disabled — you&rsquo;d be approving something you
            haven&rsquo;t seen. Ask your agency for a fresh link.
          </Banner>
        ) : (
          <>
            {preview && (
              <a
                href={`/api/preview?token=${encodeURIComponent(preview)}&to=/`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-6 inline-flex items-center gap-2 rounded-ctl bg-primary px-3.5 py-2 text-sm font-medium text-primary-fg focus-ring hover:bg-primary-hover motion-safe:transition-colors"
              >
                Open the draft preview
                <ExternalLink size={14} aria-hidden />
              </a>
            )}
            <div className="mt-6 border-t border-edge pt-5">
              <ApprovalDecision token={token} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
