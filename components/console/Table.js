import { cx } from "./cx";
import { Skeleton } from "./bits";

// Console table (S50): proper headers, consistent row spacing, numeric
// right-alignment with tabular figures, an overflow wrapper (today's
// platform tables overflow the viewport), skeleton rows while loading and
// a real empty slot. Presentational and hook-free — interactivity stays in
// the caller's cells.
//
//   columns: [{ key, header, align?: "right", width?, className? }]
//   rows:    array of records; renderCell(row, col) → node (defaults to row[col.key])

export function Table({ columns, rows, rowKey = (r, i) => r.id ?? i, renderCell, loading = false, skeletonRows = 5, empty = null, dense = false, className = "" }) {
  const cell = renderCell || ((row, col) => row[col.key]);
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-edge">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={cx("px-3 py-2 text-left text-xs font-medium text-fg-muted first:pl-0 last:pr-0", c.align === "right" && "text-right", c.className)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`s${i}`}>
                  {columns.map((c) => (
                    <td key={c.key} className={cx("px-3 first:pl-0 last:pr-0", dense ? "py-2" : "py-2.5")}>
                      <Skeleton className="h-3.5 w-full max-w-32" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, i) => (
                <tr key={rowKey(row, i)} className="group">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx(
                        "px-3 align-middle first:pl-0 last:pr-0",
                        dense ? "py-2" : "py-2.5",
                        c.align === "right" && "text-right tabular-nums",
                        c.className
                      )}
                    >
                      {cell(row, c)}
                    </td>
                  ))}
                </tr>
              ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
