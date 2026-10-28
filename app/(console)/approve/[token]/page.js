import { notFound } from "next/navigation";
import { approvalByToken, currentDraftHash } from "@/lib/platform/agency";
import { previewToken } from "@/lib/releases";
import { siteName } from "@/lib/site";
import ApprovalDecision from "@/components/ApprovalDecision";
import { tfetch } from "@/lib/tenant-request";
import { tenantId } from "@/lib/tenant-context";

// Client review page (S48 / AG04): a signed, expiring link an agency sends
// its client. Shows exactly which draft (content hash) the decision covers,
// opens a private preview (existing signed preview cookie flow), and records
// the decision with the approver's typed identity. If the draft changed
// since the link was made, deciding is blocked — fresh link, fresh hash.
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
    <div className="mx-auto max-w-xl px-4 py-14 sm:px-6">
      <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">Design review · {name}</p>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight">Your agency asked you to review a draft</h1>
      {approval.note && <p className="mt-2 text-sm text-zinc-600">“{approval.note}”</p>}
      <p className="mt-3 text-xs text-zinc-400">
        This decision covers draft <code className="font-mono">{approval.content_hash.slice(0, 12)}</code> only — if the
        design changes afterwards, a new review link is required. Link expires{" "}
        {new Date(approval.expires_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.
      </p>

      {approval.status !== "pending" ? (
        <p className="mt-6 rounded-xl bg-zinc-100 px-4 py-3 text-sm">
          This request is <strong>{approval.status}</strong>
          {approval.approver ? ` by ${approval.approver}` : ""}
          {approval.decided_at ? ` on ${new Date(approval.decided_at).toLocaleDateString("en-IN")}` : ""}.
        </p>
      ) : stale ? (
        <p className="mt-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The draft changed after this link was created, so deciding here is disabled — you&rsquo;d be approving
          something you haven&rsquo;t seen. Ask your agency for a fresh link.
        </p>
      ) : (
        <>
          {preview && (
            <a
              href={`/api/preview?token=${encodeURIComponent(preview)}&to=/`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-block rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-zinc-800"
            >
              Open the draft preview →
            </a>
          )}
          <div className="mt-6">
            <ApprovalDecision token={token} />
          </div>
        </>
      )}
    </div>
  );
}
