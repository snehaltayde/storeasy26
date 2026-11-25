import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listIncidents, openIncident, postIncidentUpdate, editInternalNote, resolveIncident, incidentTimeline, storeChoices } from "@/lib/platform/incidents";

// Incidents (S43 / OP12; the /platform/incidents screen, Phase 3 line 4):
// operator-declared, the internal note kept apart from the PUBLIC message
// merchants see in their console while the incident is open. tenant_id NULL =
// platform-wide. The history is audit_log (incident.open | update | resolve),
// and no audit row holds the internal note's text.
//   GET ?scope=all|platform|<store id>&page=n → { incidents, page, pageSize, total, openCount, stores }
//   GET ?timeline=<id>                        → { timeline }
//   POST {action:"open", title, tenant?, publicMessage?, internalNote?}
//   POST {action:"update", id, publicMessage}  → a new public message
//   POST {action:"note", id, internalNote}     → edit the internal note
//   POST {action:"resolve", id, closingMessage?}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const failed = (e) => NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: e?.status || 422 });

async function listing(p) {
  const [list, stores] = await Promise.all([listIncidents({ scope: p.get("scope") || "all", page: p.get("page") || 1 }), storeChoices()]);
  return { ok: true, ...list, stores };
}

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const p = request.nextUrl.searchParams;
  try {
    if (p.get("timeline") != null) return NextResponse.json({ ok: true, timeline: await incidentTimeline(p.get("timeline")) });
    return NextResponse.json(await listing(p));
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  const actor = auth.operator;
  try {
    let incident;
    if (body.action === "open") {
      incident = await openIncident({ title: body.title, tenantId: body.tenant || null, publicMessage: body.publicMessage, internalNote: body.internalNote, actor });
    } else if (body.action === "update") {
      incident = await postIncidentUpdate({ id: body.id, publicMessage: body.publicMessage, actor });
    } else if (body.action === "note") {
      incident = await editInternalNote({ id: body.id, internalNote: body.internalNote, actor });
    } else if (body.action === "resolve") {
      incident = await resolveIncident({ id: body.id, closingMessage: body.closingMessage, actor });
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ...(await listing(new URLSearchParams())), incident });
  } catch (e) {
    return failed(e);
  }
}
