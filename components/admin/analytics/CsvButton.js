"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

// One table's rows as a CSV file, built in the browser from the aggregated
// rows on screen (never raw events or shopper details). Nothing is sent, so
// it is a read for every role (data-read-control).
//   rows, columns: [{ key, header }], filename
export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.header)).join(","), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(","))].join("\n");
}

export function CsvButton({ rows, columns, filename, label }) {
  if (!rows?.length) return null;
  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(rows, columns)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Button type="button" variant="outline" size="sm" data-read-control onClick={download} aria-label={`Download ${label} as CSV`}>
      <Download aria-hidden />
      CSV
    </Button>
  );
}
