"use client";

import { useState } from "react";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input, Textarea } from "@/components/console/fields";

// Approve/reject form for the client review link (S48 / AG04, redesigned
// S50 on the console primitives). Approving here never publishes anything.
export default function ApprovalDecision({ token }) {
  const [approver, setApprover] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(null); // which decision is in flight
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);

  async function decide(decision) {
    setBusy(decision);
    setErr(null);
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, decision, approver, comment }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.ok && json.ok) setDone(json.status);
    else setErr(json.error || "Couldn't record the decision — try again.");
  }

  if (done) {
    return (
      <Banner tone={done === "approved" ? "success" : "neutral"}>
        Recorded: <strong>{done}</strong>. Your agency can see this — publishing still happens through the store&rsquo;s own
        release workflow.
      </Banner>
    );
  }

  const ready = approver.trim().length >= 2;
  return (
    <div className="space-y-4">
      {err && <Banner tone="danger">{err}</Banner>}
      <Field label="Your name" htmlFor="approver-name" hint="Recorded with the decision." required>
        <Input id="approver-name" value={approver} onChange={(e) => setApprover(e.target.value)} />
      </Field>
      <Field label="Comment (optional)" htmlFor="approver-comment">
        <Textarea id="approver-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy === "approved"} disabled={!ready || !!busy} onClick={() => decide("approved")}>
          Approve
        </Button>
        <Button variant="secondary" busy={busy === "rejected"} disabled={!ready || !!busy} onClick={() => decide("rejected")}>
          Request changes
        </Button>
      </div>
    </div>
  );
}
