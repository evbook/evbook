/**
 * Rows to CSV, quoting every value so commas cannot break rows. Columns come
 * from the first row, in its key order; null and undefined print as empty.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]!);
  const escape = (value: unknown) => {
    if (value === null || value === undefined) return "";
    return `"${String(value).replaceAll('"', '""')}"`;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((c) => escape(row[c])).join(","))].join("\n");
}
