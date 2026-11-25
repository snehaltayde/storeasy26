// Phase 3 line 5: the operator console's calls to /api/platform/support, and
// the words the support-access screens share.
export async function supportApi(method, body, query = "") {
  const res = await fetch(`/api/platform/support${query}`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.assign("/platform");
    return new Promise(() => {});
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || "That didn't work. Try again.");
  return json;
}

export const SUPPORT_HOURS = [1, 4, 8, 24, 72];
export const hoursLabel = (h) => (h === 1 ? "1 hour" : `${h} hours`);

export const STATE_WORDS = {
  open: { label: "Open", tone: "info" },
  closed: { label: "Closed", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
};
