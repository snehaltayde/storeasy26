"use client";

// Scoped CSV export (S42 / MC17): downloads exactly the AGGREGATED rows shown
// on screen — never raw events or shopper PII.
export default function ExportCsv({ rows, columns, filename }) {
  function download() {
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  if (!rows?.length) return null;
  return (
    <button type="button" onClick={download} className="text-xs font-medium text-lime-700 hover:underline">
      Export CSV
    </button>
  );
}
